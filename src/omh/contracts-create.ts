import { and, eq, type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agenticCommandRecords } from "@/db/agentic-access/table";
import { envelopeArtifactVersions } from "@/db/envelope/artifact-versions";
import {
	buildPartnerVerificationEmail,
	deliverTransactionalEmail,
	type EmailDeliveryOptions,
	toAbsoluteDeliveryUrl,
} from "@/db/envelope/email-delivery";
import { noEnvelopeDeletion } from "@/db/envelope/signing-batch";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope/table";
import { getDb } from "@/db/setup";
import { sha256Hex } from "@/hono/api/envelope-route-helpers";
import { prepareContractPdf } from "./contracts-pdf";
import {
	ContractError,
	type ContractSummary,
	type CreateContractRequest,
} from "./contracts-schema";

/** This freshly claimed command owns one new draft; existing documents use their lifecycle API. */
export async function createAndSendClaimedContract(input: {
	recordId: string;
	email: string;
	request: CreateContractRequest;
	documentsBucket: R2Bucket;
	emailDelivery: EmailDeliveryOptions;
}): Promise<ContractSummary> {
	const email = input.email.trim().toLowerCase();
	if (email === input.request.recipient.email.trim().toLowerCase())
		throw new ContractError(
			"EXTERNAL_RECIPIENT_REQUIRED",
			"Choose the external person who should sign this contract",
		);
	const prepared = await prepareContractPdf(input.request);
	const now = new Date();
	const envelopeId = crypto.randomUUID();
	const recipientId = crypto.randomUUID();
	const tokenId = crypto.randomUUID();
	const token = crypto.randomUUID();
	const r2Key = `envelopes/${envelopeId}/source-v1.pdf`;
	const relativeUrl = `/signing-verifications/${token}`;
	const db = getDb();
	const fieldRows = prepared.fields.map((field) => ({
		...field,
		id: crypto.randomUUID(),
		envelopeId,
		recipientId,
		createdAt: now,
	}));
	// Ten explicit fields per INSERT stay within the private database's 100 parameters.
	const fieldWrites = [];
	for (let offset = 0; offset < fieldRows.length; offset += 10)
		fieldWrites.push(db.insert(envelopeFields).values(fieldRows.slice(offset, offset + 10)));
	await db.batch([
		guardStatement(sql`select 1 / case when exists (select 1 from ${agenticCommandRecords}
			where ${agenticCommandRecords.id} = ${input.recordId} and ${agenticCommandRecords.state} = ${"pending"}
			and ${agenticCommandRecords.documentId} is null for update) then 1 else 0 end as guard`),
		db.insert(envelopes).values({
			id: envelopeId,
			createdBy: email,
			status: "draft",
			signingMode: "me_and_another_signer",
			createdAt: now,
		}),
		db.insert(sourceDocuments).values({
			id: crypto.randomUUID(),
			envelopeId,
			r2Key,
			version: 1,
			sha256: await sha256Hex(prepared.bytes),
			byteSize: prepared.bytes.byteLength,
			contentType: "application/pdf",
			originalFilename: input.request.pdf.filename,
			uploadedBy: email,
			uploadedAt: now,
		}),
		db.insert(envelopeRecipients).values({
			id: recipientId,
			envelopeId,
			...input.request.recipient,
			status: "pending",
			createdAt: now,
		}),
		...fieldWrites,
		db.insert(signerTokens).values({
			id: tokenId,
			envelopeId,
			recipientId,
			token,
			// Existing readers recognize this inactive state without accepting an undelivered link.
			status: "revoked",
			expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
			createdAt: now,
		}),
		db
			.insert(envelopeArtifactVersions)
			.values({ id: crypto.randomUUID(), envelopeId, r2Key, createdAt: now }),
		db.insert(auditEvents).values({
			id: crypto.randomUUID(),
			envelopeId,
			recipientId: null,
			eventType: "contract.created",
			message: input.request.title,
			createdAt: now,
		}),
		db
			.update(agenticCommandRecords)
			.set({ documentId: envelopeId })
			.where(
				and(
					eq(agenticCommandRecords.id, input.recordId),
					eq(agenticCommandRecords.state, "pending"),
				),
			),
	]);
	// Persist the locator and pending command first, including when upload or delivery is uncertain.
	await input.documentsBucket.put(r2Key, prepared.bytes, {
		httpMetadata: { contentType: "application/pdf" },
	});
	await deliverTransactionalEmail(
		buildPartnerVerificationEmail({
			email: input.request.recipient.email,
			recipientName: input.request.recipient.name,
			verificationUrl: toAbsoluteDeliveryUrl(relativeUrl, input.emailDelivery),
		}),
		input.emailDelivery,
	);
	const summary: ContractSummary = {
		id: envelopeId,
		title: input.request.title,
		status: "sent",
		createdAt: now.toISOString(),
		recipients: [{ ...input.request.recipient, status: "sent" }],
		completedAt: null,
		downloadUrl: null,
	};
	const sentAt = new Date();
	await db.batch([
		// Lock before evaluating the next statement's snapshot, including audit-only deletion intent.
		guardStatement(sql`select ${envelopes.id} from ${envelopes}
			inner join ${agenticCommandRecords} on ${agenticCommandRecords.documentId} = ${envelopes.id}
			where ${envelopes.id} = ${envelopeId} and ${agenticCommandRecords.id} = ${input.recordId}
			for update of ${envelopes}, ${agenticCommandRecords}`),
		// Evaluate the divisor from locked rows at execution, so a concurrent cancel/claim change
		// aborts the entire transaction rather than activating a link for a different lifecycle.
		guardStatement(sql`select 1 / case when exists (select 1 from ${envelopes}
			inner join ${agenticCommandRecords} on ${agenticCommandRecords.documentId} = ${envelopes.id}
			where ${envelopes.id} = ${envelopeId} and ${envelopes.createdBy} = ${email}
			and ${envelopes.status} = ${"draft"} and ${agenticCommandRecords.id} = ${input.recordId}
			and ${agenticCommandRecords.state} = ${"pending"}
			and ${noEnvelopeDeletion(envelopeId)}
			for update of ${envelopes}, ${agenticCommandRecords}) then 1 else 0 end as guard`),
		db
			.update(envelopes)
			.set({ status: "sent", sentBy: email, sentAt })
			.where(eq(envelopes.id, envelopeId)),
		db
			.update(envelopeRecipients)
			.set({ status: "sent" })
			.where(eq(envelopeRecipients.id, recipientId)),
		db.update(signerTokens).set({ status: "active" }).where(eq(signerTokens.id, tokenId)),
		db.insert(emailSendRecords).values({
			id: crypto.randomUUID(),
			envelopeId,
			recipientId,
			tokenId,
			email: input.request.recipient.email,
			kind: "partner_verification",
			fallbackUrl: relativeUrl,
			sentAt,
		}),
		db.insert(auditEvents).values([
			{
				id: crypto.randomUUID(),
				envelopeId,
				recipientId: null,
				eventType: "source_pdf.uploaded",
				message: email,
				createdAt: sentAt,
			},
			{
				id: crypto.randomUUID(),
				envelopeId,
				recipientId: null,
				eventType: "envelope.sent",
				message: email,
				createdAt: sentAt,
			},
			{
				id: crypto.randomUUID(),
				envelopeId,
				recipientId,
				eventType: "partner.verification.sent",
				message: input.request.recipient.email,
				createdAt: sentAt,
			},
		]),
		db
			.update(agenticCommandRecords)
			.set({
				state: "completed",
				responseStatus: 201,
				responseBody: JSON.stringify({ data: summary }),
				documentId: envelopeId,
				completedAt: sentAt,
			})
			.where(eq(agenticCommandRecords.id, input.recordId)),
	]);
	return summary;
}

function guardStatement(statement: SQL): { toSQL: () => { sql: string; params: unknown[] } } {
	return { toSQL: () => new PgDialect().sqlToQuery(statement) };
}
