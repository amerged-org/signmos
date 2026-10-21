import { eq } from "drizzle-orm";
import { getDb } from "@/db/setup";
import {
	buildSenderPartnerSignedEmail,
	deliverTransactionalEmail,
	type EmailDeliveryOptions,
	toAbsoluteDeliveryUrl,
} from "./email-delivery";
import { finalizeCompletedEnvelope } from "./finalization";
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

export async function completeSigning(
	token: SignerToken,
	input: CompleteSigningRequest,
	options: { documentsBucket?: R2Bucket; now?: Date; emailDelivery?: EmailDeliveryOptions } = {},
): Promise<CompleteSigningResult> {
	const db = getDb();
	const signature = normalizeSigningSignature(input);
	const signingDate = formatSigningDate(options.now ?? new Date());
	const [envelope] = await db
		.select()
		.from(envelopes)
		.where(eq(envelopes.id, token.envelopeId))
		.limit(1);
	const parsedEnvelope = envelope ? EnvelopeSchema.parse(envelope) : null;
	if (!parsedEnvelope) throw new Error("Envelope not found");
	if (parsedEnvelope.status !== "sent") {
		throw new SigningCompletionBlockedError(parsedEnvelope.status);
	}

	const fields = (
		await db
			.select()
			.from(envelopeFields)
			.where(eq(envelopeFields.recipientId, token.recipientId))
			.limit(100)
	)
		.map((field) => EnvelopeFieldSchema.parse(field))
		.filter(
			(field) => field.envelopeId === token.envelopeId && field.recipientId === token.recipientId,
		);
	if (fields.length === 0) throw new SigningNoAssignedFieldsError();

	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, token.envelopeId))
			.limit(10)
	).map((recipient) => RecipientSchema.parse(recipient));
	const signingRecipient = recipients.find((recipient) => recipient.id === token.recipientId);
	if (signingRecipient?.status === "completed") {
		return resumeRecordedSigning(
			token,
			signature.fieldValue,
			fields,
			recipients,
			options.documentsBucket,
		);
	}
	const senderNotificationUrl = buildSenderSigningNotificationUrl(token.envelopeId);
	const shouldNotifySender =
		Boolean(signingRecipient) &&
		!sameEmail(signingRecipient?.email ?? "", parsedEnvelope.createdBy);
	if (shouldNotifySender && signingRecipient && options.emailDelivery) {
		await deliverTransactionalEmail(
			buildSenderPartnerSignedEmail({
				email: parsedEnvelope.createdBy,
				signerName: signingRecipient.name,
				statusUrl: toAbsoluteDeliveryUrl(senderNotificationUrl, options.emailDelivery),
			}),
			options.emailDelivery,
		);
	}

	await db
		.insert(fieldValues)
		.values(
			fields.map((field) => ({
				envelopeId: token.envelopeId,
				recipientId: token.recipientId,
				fieldId: field.id,
				value: field.type === "signature" ? signature.fieldValue : signingDate,
			})),
		)
		.returning();
	await db
		.insert(auditEvents)
		.values([
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
		])
		.returning();
	await db
		.update(envelopeRecipients)
		.set({ status: "completed" })
		.where(eq(envelopeRecipients.id, token.recipientId));

	if (input.rememberSignature && signingRecipient) {
		await rememberPartnerSignaturePreference({
			envelopeId: token.envelopeId,
			email: signingRecipient.email,
			signature,
		});
	}
	const envelopeStatus = recipients.every(
		(recipient) => recipient.id === token.recipientId || recipient.status === "completed",
	)
		? "completed"
		: "sent";
	if (shouldNotifySender) {
		await db
			.insert(emailSendRecords)
			.values({
				envelopeId: token.envelopeId,
				recipientId: token.recipientId,
				tokenId: token.id,
				email: parsedEnvelope.createdBy,
				kind: "partner_signed",
				fallbackUrl: senderNotificationUrl,
			})
			.returning();
	}
	if (envelopeStatus === "completed") {
		await finishEnvelopeArtifact(token.envelopeId, options.documentsBucket);
	}

	return {
		envelopeId: token.envelopeId,
		recipientId: token.recipientId,
		recipientStatus: "completed",
		envelopeStatus,
	};
}

async function resumeRecordedSigning(
	token: SignerToken,
	signatureValue: string,
	fields: EnvelopeField[],
	recipients: Recipient[],
	documentsBucket?: R2Bucket,
): Promise<CompleteSigningResult> {
	if (!recipients.every((recipient) => recipient.status === "completed")) {
		throw new SigningCompletionBlockedError("sent");
	}
	const saved = await getDb()
		.select()
		.from(fieldValues)
		.where(eq(fieldValues.recipientId, token.recipientId))
		.limit(100);
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
	await finishEnvelopeArtifact(token.envelopeId, documentsBucket);
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
): Promise<void> {
	try {
		const document = await finalizeCompletedEnvelope(envelopeId, { documentsBucket });
		if (!document) throw new SigningFinalizationError();
	} catch {
		// Recipient values stay durable, but the envelope remains open. An identical
		// retry resumes artifact creation without replacing the recorded signature.
		throw new SigningFinalizationError();
	}
	await getDb().update(envelopes).set({ status: "completed" }).where(eq(envelopes.id, envelopeId));
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

async function rememberPartnerSignaturePreference(input: {
	envelopeId: string;
	email: string;
	signature: NormalizedSigningSignature;
}): Promise<void> {
	const db = getDb();
	await db
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
		)
		.returning();
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
