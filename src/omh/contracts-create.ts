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
import type { MultipartContractRequest } from "./contracts-multipart";
import { contractInvitationOutbox } from "./contracts-outbox-table";
import { prepareContractPdf } from "./contracts-pdf";
import { preparePlaceholderContract } from "./contracts-placeholders";
import {
	ContractError,
	type ContractSummary,
	type CreateContractRequest,
} from "./contracts-schema";

/** This freshly claimed command owns one new draft; existing documents use their lifecycle API. */
export async function createAndSendClaimedContract(input: {
	recordId: string;
	email: string;
	request: CreateContractRequest | MultipartContractRequest;
	documentsBucket: R2Bucket;
	emailDelivery: EmailDeliveryOptions;
}): Promise<ContractSummary> {
	const email = input.email.trim().toLowerCase();
	const request = input.request;
	const sourceRecipients =
		"kind" in request ? request.recipients : [{ ...request.recipient, index: 1 }];
	if (sourceRecipients.some((recipient) => email === recipient.email.trim().toLowerCase()))
		throw new ContractError(
			"EXTERNAL_RECIPIENT_REQUIRED",
			"Each recipient must differ from the sender",
		);
	const prepared =
		"kind" in request
			? await preparePlaceholderContract(request)
			: await prepareContractPdf(request);
	const now = new Date();
	const envelopeId = crypto.randomUUID();
	const recipients = sourceRecipients.map((recipient) => ({
		...recipient,
		id: crypto.randomUUID(),
		tokenId: crypto.randomUUID(),
		token: crypto.randomUUID(),
	}));
	const r2Key = `envelopes/${envelopeId}/source-v1.pdf`;
	const db = getDb();
	const fieldRows = prepared.fields.map((field) => {
		const { recipient: recipientIndex, ...positionedField } = {
			recipient: undefined as number | undefined,
			...field,
		};
		const recipientId = recipients.find(
			(recipient) => recipient.index === (recipientIndex ?? 1),
		)?.id;
		if (!recipientId)
			throw new ContractError("INVALID_FIELDS", "A field references an unknown recipient");
		return { ...positionedField, id: crypto.randomUUID(), envelopeId, recipientId, createdAt: now };
	});
	// Five explicit fields per INSERT stay within the private database's 100 parameters.
	const fieldWrites = [];
	for (let offset = 0; offset < fieldRows.length; offset += 5)
		fieldWrites.push(db.insert(envelopeFields).values(fieldRows.slice(offset, offset + 5)));
	await db.batch([
		guardStatement(sql`select 1 / case when exists (select 1 from ${agenticCommandRecords}
			where ${agenticCommandRecords.id} = ${input.recordId} and ${agenticCommandRecords.state} = ${"pending"}
			and ${agenticCommandRecords.documentId} is null for update) then 1 else 0 end as guard`),
		db.insert(envelopes).values({
			id: envelopeId,
			createdBy: email,
			status: "kind" in request ? "preparing" : "draft",
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
		...recipients.map((recipient) =>
			db.insert(envelopeRecipients).values({
				id: recipient.id,
				envelopeId,
				name: recipient.name,
				email: recipient.email,
				status: "pending",
				createdAt: now,
			}),
		),
		...fieldWrites,
		...recipients.map((recipient) =>
			db.insert(signerTokens).values({
				id: recipient.tokenId,
				envelopeId,
				recipientId: recipient.id,
				token: recipient.token,
				status: "revoked",
				expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
				createdAt: now,
			}),
		),
		...("kind" in request
			? recipients.map((recipient) => {
					const verificationUrl = toAbsoluteDeliveryUrl(
						`/signing-verifications/${recipient.token}`,
						input.emailDelivery,
					);
					const mail = buildPartnerVerificationEmail({
						email: recipient.email,
						recipientName: recipient.name,
						verificationUrl,
					});
					return db.insert(contractInvitationOutbox).values({
						id: crypto.randomUUID(),
						envelopeId,
						recipientId: recipient.id,
						tokenId: recipient.tokenId,
						status: "prepared",
						createdAt: now,
						updatedAt: now,
						toEmail: mail.to,
						fromEmail:
							input.emailDelivery.env?.SIGN_FROM_EMAIL ??
							input.emailDelivery.env?.RESEND_FROM_EMAIL ??
							"",
						replyToEmail:
							input.emailDelivery.env?.SIGN_REPLY_TO_EMAIL ??
							input.emailDelivery.env?.RESEND_REPLY_TO_EMAIL ??
							null,
						subject: mail.subject,
						textBody: mail.text,
						htmlBody: mail.html,
						verificationUrl,
					});
				})
			: []),
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
	if ("kind" in request) {
		const summary: ContractSummary = {
			id: envelopeId,
			title: request.title,
			status: "queued",
			createdAt: now.toISOString(),
			recipients: recipients.map(({ name, email }) => ({ name, email, status: "pending" })),
			completedAt: null,
			downloadUrl: null,
		};
		const queuedAt = new Date();
		await db.batch([
			guardStatement(sql`select ${envelopes.id} from ${envelopes}
				inner join ${agenticCommandRecords} on ${agenticCommandRecords.documentId} = ${envelopes.id}
				where ${envelopes.id} = ${envelopeId} and ${agenticCommandRecords.id} = ${input.recordId}
				for update of ${envelopes}, ${agenticCommandRecords}`),
			guardStatement(sql`select 1 / case when exists (select 1 from ${envelopes}
				inner join ${agenticCommandRecords} on ${agenticCommandRecords.documentId} = ${envelopes.id}
				where ${envelopes.id} = ${envelopeId} and ${envelopes.createdBy} = ${email}
				and ${envelopes.status} = ${"preparing"} and ${agenticCommandRecords.id} = ${input.recordId}
				and ${agenticCommandRecords.state} = ${"pending"} and ${noEnvelopeDeletion(envelopeId)}
				for update of ${envelopes}, ${agenticCommandRecords}) then 1 else 0 end as guard`),
			db.update(envelopes).set({ status: "queued" }).where(eq(envelopes.id, envelopeId)),
			db
				.update(contractInvitationOutbox)
				.set({ status: "queued", updatedAt: queuedAt })
				.where(
					and(
						eq(contractInvitationOutbox.envelopeId, envelopeId),
						eq(contractInvitationOutbox.status, "prepared"),
					),
				),
			db
				.update(agenticCommandRecords)
				.set({
					state: "completed",
					responseStatus: 202,
					responseBody: JSON.stringify({ data: summary }),
					documentId: envelopeId,
					completedAt: queuedAt,
				})
				.where(eq(agenticCommandRecords.id, input.recordId)),
		]);
		return summary;
	}
	for (const recipient of recipients) {
		const relativeUrl = `/signing-verifications/${recipient.token}`;
		await deliverTransactionalEmail(
			buildPartnerVerificationEmail({
				email: recipient.email,
				recipientName: recipient.name,
				verificationUrl: toAbsoluteDeliveryUrl(relativeUrl, input.emailDelivery),
			}),
			input.emailDelivery,
		);
	}
	const summary: ContractSummary = {
		id: envelopeId,
		title: input.request.title,
		status: "sent",
		createdAt: now.toISOString(),
		recipients: recipients.map(({ name, email }) => ({ name, email, status: "sent" })),
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
		...recipients.map((recipient) =>
			db
				.update(envelopeRecipients)
				.set({ status: "sent" })
				.where(eq(envelopeRecipients.id, recipient.id)),
		),
		...recipients.map((recipient) =>
			db
				.update(signerTokens)
				.set({ status: "active" })
				.where(eq(signerTokens.id, recipient.tokenId)),
		),
		...recipients.map((recipient) =>
			db.insert(emailSendRecords).values({
				id: crypto.randomUUID(),
				envelopeId,
				recipientId: recipient.id,
				tokenId: recipient.tokenId,
				email: recipient.email,
				kind: "partner_verification",
				fallbackUrl: `/signing-verifications/${recipient.token}`,
				sentAt,
			}),
		),
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
			...recipients.map((recipient) => ({
				id: crypto.randomUUID(),
				envelopeId,
				recipientId: recipient.id,
				eventType: "partner.verification.sent",
				message: recipient.email,
				createdAt: sentAt,
			})),
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
