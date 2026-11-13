import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/setup";
import {
	buildSenderPartnerSignedEmail,
	deliverTransactionalEmail,
	type EmailDeliveryOptions,
	toAbsoluteDeliveryUrl,
} from "./email-delivery";
import { finalizeCompletedEnvelope, getSigningFinalizationSnapshot } from "./finalization";
import { FinalizationPhaseError } from "./finalization-diagnostics";
import {
	type CompleteSigningRequest,
	type CompleteSigningResult,
	type CompleteSigningSignature,
	type Envelope,
	type EnvelopeField,
	EnvelopeFieldSchema,
	EnvelopeSchema,
	type Recipient,
	RecipientSchema,
	type SignerToken,
} from "./schema";
import {
	isSigningGuardFailure,
	noEnvelopeDeletion,
	type SigningBatchQuery,
	signingBatch,
	signingStatement,
} from "./signing-batch";
import { resolveSigningFieldValues } from "./signing-field-values";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	signatureProfiles,
} from "./table";

export class SigningCompletionBlockedError extends Error {
	constructor(public readonly status: Envelope["status"]) {
		super("Envelope is not open for completion");
		this.name = "SigningCompletionBlockedError";
	}
}

export class SigningNoAssignedFieldsError extends Error {
	constructor() {
		super("No signing fields are assigned to this recipient");
		this.name = "SigningNoAssignedFieldsError";
	}
}

export class SigningFinalizationError extends Error {
	readonly code = "FINAL_PDF_GENERATION_FAILED";
	readonly retryable = true;
	constructor(
		readonly phase?: string,
		readonly reason?: string,
	) {
		super("The signed PDF is not ready. Retry completion to finish the same document.");
		this.name = "SigningFinalizationError";
	}
}

export interface SigningCompletionContext {
	envelope: Envelope;
	fields: EnvelopeField[];
	recipients: Recipient[];
	saved: Array<Record<string, unknown>>;
}

export async function completeSigning(
	token: SignerToken,
	input: CompleteSigningRequest,
	options: {
		documentsBucket?: R2Bucket;
		now?: Date;
		emailDelivery?: EmailDeliveryOptions;
		context?: SigningCompletionContext;
	} = {},
): Promise<CompleteSigningResult> {
	const db = getDb();
	const signature =
		input.signature || input.signatureName ? normalizeSigningSignature(input) : undefined;
	const signingDate = formatSigningDate(options.now ?? new Date());
	const context = options.context ?? (await getSigningCompletionContext(token));
	const parsedEnvelope = context.envelope;
	if (parsedEnvelope.status !== "sent")
		throw new SigningCompletionBlockedError(parsedEnvelope.status);
	const fields = context.fields.filter(
		(field) => field.envelopeId === token.envelopeId && field.recipientId === token.recipientId,
	);
	if (fields.length === 0) throw new SigningNoAssignedFieldsError();
	const resolvedValues = resolveSigningFieldValues(
		fields,
		input,
		signature?.fieldValue,
		signingDate,
	);
	const recipients = context.recipients;
	const signingRecipient = recipients.find((recipient) => recipient.id === token.recipientId);
	if (!signingRecipient) throw new SigningCompletionBlockedError("sent");
	if (signingRecipient.status === "completed")
		return resumeRecordedSigning(
			token,
			resolvedValues,
			fields,
			recipients,
			context.saved,
			options.documentsBucket,
			options.now,
			parsedEnvelope.createdBy,
			signingRecipient.email,
		);
	if (signingRecipient.status !== "sent") throw new SigningCompletionBlockedError("sent");
	const senderNotificationUrl = buildSenderSigningNotificationUrl(token.envelopeId);
	const shouldNotifySender = !sameEmail(signingRecipient.email, parsedEnvelope.createdBy);
	if (shouldNotifySender && options.emailDelivery) {
		await deliverTransactionalEmail(
			buildSenderPartnerSignedEmail({
				email: parsedEnvelope.createdBy,
				signerName: signingRecipient.name,
				statusUrl: toAbsoluteDeliveryUrl(senderNotificationUrl, options.emailDelivery),
			}),
			options.emailDelivery,
		);
	}

	const writes: SigningBatchQuery[] = [
		signingStatement(sql`select id from envelopes where id = ${token.envelopeId} for update`),
		signingStatement(sql`/* signing-record-guard */
			with locked as (
				select e.status as envelope_status, e.created_by, r.status as recipient_status, r.email,
					t.status as token_status, t.verified_at, t.expires_at
				from envelopes e join envelope_recipients r on r.envelope_id = e.id
				join signer_tokens t on t.envelope_id = e.id and t.recipient_id = r.id
				where e.id = ${token.envelopeId} and r.id = ${token.recipientId}
					and t.id = ${token.id} and t.token = ${token.token}
				for update of e, r, t
			)
			select 1 / case when exists (
				select 1 from locked where envelope_status = 'sent' and recipient_status = 'sent' and created_by = ${parsedEnvelope.createdBy} and email = ${signingRecipient.email}
					and ${noEnvelopeDeletion(token.envelopeId)} and token_status = 'active' and verified_at is not null
					and expires_at > ${options.now ?? new Date()}
			) then 1 else 0 end as allowed`),
		db.insert(fieldValues).values(
			fields.map((field) => ({
				envelopeId: token.envelopeId,
				recipientId: token.recipientId,
				fieldId: field.id,
				value: resolvedValues.get(field.id) ?? "",
			})),
		),
		db.insert(auditEvents).values([
			{
				envelopeId: token.envelopeId,
				recipientId: token.recipientId,
				eventType: "field.value.completed",
				message: signature?.auditMessage ?? null,
			},
			{
				envelopeId: token.envelopeId,
				recipientId: token.recipientId,
				eventType: "recipient.completed",
				message: null,
			},
		]),
		db
			.update(envelopeRecipients)
			.set({ status: "completed" })
			.where(
				and(
					eq(envelopeRecipients.id, token.recipientId),
					eq(envelopeRecipients.envelopeId, token.envelopeId),
				),
			),
	];
	if (input.rememberSignature && signature)
		writes.push(
			rememberPartnerSignaturePreference({
				envelopeId: token.envelopeId,
				email: signingRecipient.email,
				signature,
			}),
		);
	if (shouldNotifySender)
		writes.push(
			db.insert(emailSendRecords).values({
				envelopeId: token.envelopeId,
				recipientId: token.recipientId,
				tokenId: token.id,
				email: parsedEnvelope.createdBy,
				kind: "partner_signed",
				fallbackUrl: senderNotificationUrl,
			}),
		);
	const envelopeStatus = await persistSigningCompletion(
		token,
		writes,
		options.documentsBucket,
		options.now,
		parsedEnvelope.createdBy,
		signingRecipient.email,
	);

	return {
		envelopeId: token.envelopeId,
		recipientId: token.recipientId,
		recipientStatus: "completed",
		envelopeStatus,
	};
}

async function persistSigningCompletion(
	token: SignerToken,
	writes: SigningBatchQuery[],
	documentsBucket: R2Bucket | undefined,
	now: Date | undefined,
	owner: string,
	recipientEmail: string,
): Promise<"sent" | "completed"> {
	try {
		// Determine completion after recording the recipient while holding the envelope lock.
		// Two recipients can otherwise both observe the other as pending and never finalize.
		const snapshot = await getSigningFinalizationSnapshot(token.envelopeId, writes);
		if (snapshot.recipients.every((recipient) => recipient.status === "completed")) {
			await finishEnvelopeArtifact(
				token.envelopeId,
				documentsBucket,
				snapshot,
				token,
				now,
				owner,
				recipientEmail,
			);
			return "completed";
		}
		return "sent";
	} catch (error) {
		if (isSigningGuardFailure(error)) throw new SigningCompletionBlockedError("sent");
		throw error;
	}
}

async function getSigningCompletionContext(token: SignerToken): Promise<SigningCompletionContext> {
	const db = getDb();
	const [envelopeRows, fieldRows, recipientRows, saved] = await signingBatch([
		{
			table: envelopes,
			query: db.select().from(envelopes).where(eq(envelopes.id, token.envelopeId)).limit(1),
		},
		{
			table: envelopeFields,
			query: db
				.select()
				.from(envelopeFields)
				.where(eq(envelopeFields.envelopeId, token.envelopeId))
				.limit(100),
		},
		{
			table: envelopeRecipients,
			query: db
				.select()
				.from(envelopeRecipients)
				.where(eq(envelopeRecipients.envelopeId, token.envelopeId))
				.limit(10),
		},
		{
			table: fieldValues,
			query: db
				.select()
				.from(fieldValues)
				.where(eq(fieldValues.recipientId, token.recipientId))
				.limit(100),
		},
	]);
	return {
		envelope: EnvelopeSchema.parse(envelopeRows?.[0]),
		fields: (fieldRows ?? []).map((row) => EnvelopeFieldSchema.parse(row)),
		recipients: (recipientRows ?? []).map((row) => RecipientSchema.parse(row)),
		saved: saved ?? [],
	};
}

async function resumeRecordedSigning(
	token: SignerToken,
	values: Map<string, string>,
	fields: EnvelopeField[],
	recipients: Recipient[],
	saved: Array<Record<string, unknown>>,
	documentsBucket?: R2Bucket,
	now?: Date,
	owner?: string,
	recipientEmail?: string,
): Promise<CompleteSigningResult> {
	if (!recipients.every((recipient) => recipient.status === "completed")) {
		throw new SigningCompletionBlockedError("sent");
	}
	const savedByField = new Map(saved.map((value) => [value.fieldId, value.value]));
	if (
		fields.some(
			(field) =>
				!savedByField.has(field.id) ||
				((field.type !== "date" || field.name !== null) &&
					savedByField.get(field.id) !== values.get(field.id)),
		)
	) {
		throw new SigningCompletionBlockedError("sent");
	}
	await finishEnvelopeArtifact(
		token.envelopeId,
		documentsBucket,
		undefined,
		token,
		now,
		owner,
		recipientEmail,
	);
	return {
		envelopeId: token.envelopeId,
		recipientId: token.recipientId,
		recipientStatus: "completed",
		envelopeStatus: "completed",
	};
}

async function finishEnvelopeArtifact(
	envelopeId: string,
	documentsBucket?: R2Bucket,
	snapshot?: Awaited<ReturnType<typeof getSigningFinalizationSnapshot>>,
	token?: SignerToken,
	now?: Date,
	owner?: string,
	recipientEmail?: string,
): Promise<void> {
	try {
		const document = await finalizeCompletedEnvelope(envelopeId, {
			documentsBucket,
			snapshot,
			completion: token ? { token, now: now ?? new Date(), owner, recipientEmail } : undefined,
		});
		if (!document) throw new SigningFinalizationError();
	} catch (error) {
		// Recipient values stay durable, but the envelope remains open. An identical
		// retry resumes artifact creation without replacing the recorded signature.
		if (error instanceof FinalizationPhaseError)
			throw new SigningFinalizationError(error.phase, error.reason);
		throw new SigningFinalizationError();
	}
}

type NormalizedSigningSignature =
	| {
			kind: "typed";
			fieldValue: string;
			auditMessage: string;
			typedText: string;
			typedFont: string;
	  }
	| {
			kind: "drawn";
			fieldValue: string;
			auditMessage: string;
			label: string;
			svgPath: string;
	  };

function normalizeSigningSignature(input: CompleteSigningRequest): NormalizedSigningSignature {
	const signature = input.signature ?? legacyTypedSigningSignature(input.signatureName);
	if (signature.kind === "typed") {
		return {
			kind: "typed",
			fieldValue: signature.typedText,
			auditMessage: signature.typedText,
			typedText: signature.typedText,
			typedFont: signature.typedFont,
		};
	}
	return {
		kind: "drawn",
		fieldValue: signature.svgPath,
		auditMessage: signature.label,
		label: signature.label,
		svgPath: signature.svgPath,
	};
}

function legacyTypedSigningSignature(signatureName: string | undefined): CompleteSigningSignature {
	const typedText = signatureName?.trim();
	if (!typedText) throw new Error("Signature is required");
	return {
		kind: "typed",
		typedText,
		typedFont: "cursive",
	};
}

function rememberPartnerSignaturePreference(input: {
	envelopeId: string;
	email: string;
	signature: NormalizedSigningSignature;
}): SigningBatchQuery {
	return getDb()
		.insert(signatureProfiles)
		.values(
			input.signature.kind === "typed"
				? {
						envelopeId: input.envelopeId,
						createdBy: normalizeSignatureProfileActor(input.email),
						kind: "typed",
						label: "Typed signature",
						svgPath: null,
						typedText: input.signature.typedText,
						typedFont: input.signature.typedFont,
						selected: true,
					}
				: {
						envelopeId: input.envelopeId,
						createdBy: normalizeSignatureProfileActor(input.email),
						kind: "drawn",
						label: input.signature.label,
						svgPath: input.signature.svgPath,
						typedText: null,
						typedFont: null,
						selected: true,
					},
		);
}

function buildSenderSigningNotificationUrl(envelopeId: string): string {
	return `/envelope-fields?envelopeId=${envelopeId}`;
}

function sameEmail(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizeSignatureProfileActor(actor: string): string {
	return actor.trim().toLowerCase();
}

function formatSigningDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}
