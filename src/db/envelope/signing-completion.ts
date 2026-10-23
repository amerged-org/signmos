import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/setup";
import { OWNER_NOTICE_TIMEOUT_MILLISECONDS } from "@/omh/mail";
import {
	buildSenderPartnerSignedEmail,
	deliverTransactionalEmail,
	type EmailDeliveryOptions,
	toAbsoluteDeliveryUrl,
} from "./email-delivery";
import { finalizeCompletedEnvelope, getSigningFinalizationSnapshot } from "./finalization";
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
	constructor() {
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
	const signature = normalizeSigningSignature(input);
	const signingDate = formatSigningDate(options.now ?? new Date());
	const context = options.context ?? (await getSigningCompletionContext(token));
	const parsedEnvelope = context.envelope;
	if (parsedEnvelope.status !== "sent")
		throw new SigningCompletionBlockedError(parsedEnvelope.status);
	const fields = context.fields.filter(
		(field) => field.envelopeId === token.envelopeId && field.recipientId === token.recipientId,
	);
	if (fields.length === 0) throw new SigningNoAssignedFieldsError();
	const recipients = context.recipients;
	const signingRecipient = recipients.find((recipient) => recipient.id === token.recipientId);
	if (!signingRecipient) throw new SigningCompletionBlockedError("sent");
	if (signingRecipient.status === "completed") {
		const result = await resumeRecordedSigning(
			token,
			signature.fieldValue,
			fields,
			recipients,
			context.saved,
			options.documentsBucket,
			options.now,
			parsedEnvelope.createdBy,
			signingRecipient.email,
		);
		if (!sameEmail(signingRecipient.email, parsedEnvelope.createdBy))
			await notifySenderSigned(token, parsedEnvelope.createdBy, signingRecipient.name, options);
		return result;
	}
	if (signingRecipient.status !== "sent") throw new SigningCompletionBlockedError("sent");
	const senderNotificationUrl = buildSenderSigningNotificationUrl(token.envelopeId);
	const shouldNotifySender = !sameEmail(signingRecipient.email, parsedEnvelope.createdBy);

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
				value: field.type === "signature" ? signature.fieldValue : signingDate,
			})),
		),
		db.insert(auditEvents).values([
			{
				envelopeId: token.envelopeId,
				recipientId: token.recipientId,
				eventType: "field.value.completed",
				message: signature.auditMessage,
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
	if (input.rememberSignature)
		writes.push(
			rememberPartnerSignaturePreference({
				envelopeId: token.envelopeId,
				email: signingRecipient.email,
				signature,
			}),
		);
	const envelopeStatus = recipients.every(
		(recipient) => recipient.id === token.recipientId || recipient.status === "completed",
	)
		? "completed"
		: "sent";
	if (shouldNotifySender)
		writes.push(
			// States only that the notice was requested with the signature, see notifySenderSigned.
			db.insert(emailSendRecords).values({
				envelopeId: token.envelopeId,
				recipientId: token.recipientId,
				tokenId: token.id,
				email: parsedEnvelope.createdBy,
				kind: "partner_signed_notice_requested",
				fallbackUrl: senderNotificationUrl,
			}),
		);
	await persistSigningCompletion(
		token,
		envelopeStatus,
		writes,
		options.documentsBucket,
		options.now,
		parsedEnvelope.createdBy,
		signingRecipient.email,
	);
	// Only now is the signature stored; the owner mail is a courtesy that must never block it.
	if (shouldNotifySender)
		await notifySenderSigned(token, parsedEnvelope.createdBy, signingRecipient.name, options);

	return {
		envelopeId: token.envelopeId,
		recipientId: token.recipientId,
		recipientStatus: "completed",
		envelopeStatus,
	};
}

/**
 * Tell the owner that a signer signed, after the signature is durable. A mail refusal (daily
 * send limit, suspended sender, unpaid workspace, timeout) must not undo, block or repeat the
 * signing, so it is swallowed. The signer's answer waits for this courtesy mail, so the send gives
 * up after OWNER_NOTICE_TIMEOUT_MILLISECONDS instead of the longer default deadline of mails such
 * as login and invitation.
 *
 * Its outcome is not recorded either: the flow already uses all ten private calls a Worker may
 * make, so recording it would take an eleventh. The `partner_signed_notice_requested` row was
 * therefore written in the signature transaction, before this send, and states only that the
 * notice was requested together with the signature; delivery is unknown. Only the mail gateway's
 * ledger and the owner's mailbox show what became of the mail.
 *
 * The message is a pure function of the owner, the signer and the status link, so its
 * content-derived idempotency key makes a repeated call a gateway replay instead of a second mail.
 */
async function notifySenderSigned(
	token: SignerToken,
	owner: string,
	signerName: string,
	options: { emailDelivery?: EmailDeliveryOptions },
): Promise<void> {
	const delivery = options.emailDelivery;
	if (!delivery) return;
	try {
		await deliverTransactionalEmail(
			buildSenderPartnerSignedEmail({
				email: owner,
				signerName,
				statusUrl: toAbsoluteDeliveryUrl(
					buildSenderSigningNotificationUrl(token.envelopeId),
					delivery,
				),
			}),
			{ ...delivery, timeoutMilliseconds: OWNER_NOTICE_TIMEOUT_MILLISECONDS },
		);
	} catch {
		// Best effort: the owner sees the completed contract in the console either way.
	}
}

async function persistSigningCompletion(
	token: SignerToken,
	envelopeStatus: "sent" | "completed",
	writes: SigningBatchQuery[],
	documentsBucket: R2Bucket | undefined,
	now: Date | undefined,
	owner: string,
	recipientEmail: string,
): Promise<void> {
	try {
		if (envelopeStatus === "completed") {
			const snapshot = await getSigningFinalizationSnapshot(token.envelopeId, writes);
			await finishEnvelopeArtifact(
				token.envelopeId,
				documentsBucket,
				snapshot,
				token,
				now,
				owner,
				recipientEmail,
			);
		} else {
			await signingBatch(writes);
		}
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
	signatureValue: string,
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
				(field.type === "signature" && savedByField.get(field.id) !== signatureValue),
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
	} catch {
		// Recipient values stay durable, but the envelope remains open. An identical
		// retry resumes artifact creation without replacing the recorded signature.
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
