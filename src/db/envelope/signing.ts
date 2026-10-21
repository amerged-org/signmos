import { eq } from "drizzle-orm";
import { getDb } from "@/db/setup";
import {
	type DeclineSigningRequest,
	type DeclineSigningResult,
	type Envelope,
	EnvelopeFieldSchema,
	EnvelopeSchema,
	FieldValueSchema,
	getEnvelopeAllowedActions,
	RecipientSchema,
	SignatureProfileSchema,
	type SignerSession,
	type SignerToken,
	SignerTokenSchema,
	type SourceDocument,
	SourceDocumentSchema,
	toSignatureProfileResponse,
} from "./schema";
import {
	auditEvents,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	signatureProfiles,
	signerTokens,
	sourceDocuments,
} from "./table";

export class SigningFieldPlacementBlockedError extends Error {
	constructor() {
		super("Only self-sign envelopes can reposition signing fields");
		this.name = "SigningFieldPlacementBlockedError";
	}
}

export class SigningFieldPlacementNotFoundError extends Error {
	constructor() {
		super("Signing field was not found");
		this.name = "SigningFieldPlacementNotFoundError";
	}
}

export type SignerFieldPlacementUpdate = { fieldId: string; page?: number; x: number; y: number };

const signingPdfPage = { width: 612, height: 792 } as const;

export async function resolveSignerToken(token: string): Promise<SignerToken | null> {
	const db = getDb();
	const tokens = await db.select().from(signerTokens).where(eq(signerTokens.token, token)).limit(1);
	const found = tokens.find((candidate) => candidate.token === token);
	if (!found) return null;
	const parsed = SignerTokenSchema.parse(found);
	return parsed.status === "active" ? parsed : null;
}

export async function getSignerSession(
	token: SignerToken,
	options: { sourceDownloadUrl?: string } = {},
): Promise<SignerSession> {
	const db = getDb();
	const [envelope] = await db
		.select()
		.from(envelopes)
		.where(eq(envelopes.id, token.envelopeId))
		.limit(1);
	const parsedEnvelope = envelope ? EnvelopeSchema.parse(envelope) : null;
	if (!parsedEnvelope) throw new Error("Envelope not found");
	const allFields = (
		await db
			.select()
			.from(envelopeFields)
			.where(eq(envelopeFields.envelopeId, token.envelopeId))
			.limit(100)
	).map((field) => EnvelopeFieldSchema.parse(field));
	const fields = allFields.filter((field) => field.recipientId === token.recipientId);
	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, token.envelopeId))
			.limit(10)
	).map((recipient) => RecipientSchema.parse(recipient));
	const fieldValueRows = (
		await db
			.select()
			.from(fieldValues)
			.where(eq(fieldValues.envelopeId, token.envelopeId))
			.limit(100)
	).map((value) => FieldValueSchema.parse(value));
	const sourceDocumentsForEnvelope = (
		await db
			.select()
			.from(sourceDocuments)
			.where(eq(sourceDocuments.envelopeId, token.envelopeId))
			.limit(100)
	).map((document) => SourceDocumentSchema.parse(document));
	const sourceDocument = latestSourceDocument(sourceDocumentsForEnvelope);
	if (!sourceDocument) throw new Error("Envelope source PDF required");
	const recipient = recipients.find((candidate) => candidate.id === token.recipientId) ?? null;
	const signaturePreference = recipient
		? await getLatestSignaturePreferenceForEmail(recipient.email)
		: null;
	const recipientNames = new Map(
		recipients.map((candidate) => [candidate.id, candidate.name] as const),
	);
	const fieldValuesById = new Map(fieldValueRows.map((value) => [value.fieldId, value.value]));

	await db
		.insert(auditEvents)
		.values({
			envelopeId: token.envelopeId,
			recipientId: token.recipientId,
			eventType: "partner.signing.viewed",
			message: null,
		})
		.returning();

	return {
		envelopeId: token.envelopeId,
		recipientId: token.recipientId,
		signingMode: parsedEnvelope.signingMode,
		sourceDocument: {
			version: sourceDocument.version,
			contentType: sourceDocument.contentType,
			downloadUrl: options.sourceDownloadUrl ?? `/api/signing/${token.token}/source-pdf`,
		},
		fields: fields.map((field) => ({
			id: field.id,
			type: field.type,
			page: field.page,
			x: field.x,
			y: field.y,
			width: field.width,
			height: field.height,
		})),
		previewFields: allFields.map((field) => ({
			id: field.id,
			recipientId: field.recipientId,
			recipientName: recipientNames.get(field.recipientId) ?? "Signer",
			type: field.type,
			page: field.page,
			x: field.x,
			y: field.y,
			width: field.width,
			height: field.height,
			value: fieldValuesById.get(field.id) ?? null,
			assignedToCurrentSigner: field.recipientId === token.recipientId,
		})),
		signaturePreference: signaturePreference
			? toSignatureProfileResponse(signaturePreference)
			: null,
	};
}

export async function updateSignerFieldPlacement(
	token: SignerToken,
	input: SignerFieldPlacementUpdate,
): Promise<SignerSession["fields"][number]> {
	const db = getDb();
	const [envelope] = await db
		.select()
		.from(envelopes)
		.where(eq(envelopes.id, token.envelopeId))
		.limit(1);
	const parsedEnvelope = envelope ? EnvelopeSchema.parse(envelope) : null;
	if (!parsedEnvelope) throw new Error("Envelope not found");
	if (parsedEnvelope.status !== "sent" || parsedEnvelope.signingMode !== "only_me") {
		throw new SigningFieldPlacementBlockedError();
	}

	const fields = (
		await db
			.select()
			.from(envelopeFields)
			.where(eq(envelopeFields.envelopeId, token.envelopeId))
			.limit(100)
	).map((field) => EnvelopeFieldSchema.parse(field));
	const field = fields.find(
		(candidate) => candidate.id === input.fieldId && candidate.recipientId === token.recipientId,
	);
	if (!field) throw new SigningFieldPlacementNotFoundError();

	const nextField = {
		...field,
		page: input.page ?? field.page,
		x: clamp(input.x, 0, signingPdfPage.width - field.width),
		y: clamp(input.y, 0, signingPdfPage.height - field.height),
	};
	await db
		.update(envelopeFields)
		.set({ page: nextField.page, x: nextField.x, y: nextField.y })
		.where(eq(envelopeFields.id, field.id));
	return {
		id: nextField.id,
		type: nextField.type,
		page: nextField.page,
		x: nextField.x,
		y: nextField.y,
		width: nextField.width,
		height: nextField.height,
	};
}

export async function getSignerSourceDocument(token: SignerToken): Promise<SourceDocument | null> {
	const db = getDb();
	const documents = (
		await db
			.select()
			.from(sourceDocuments)
			.where(eq(sourceDocuments.envelopeId, token.envelopeId))
			.limit(100)
	).map((document) => SourceDocumentSchema.parse(document));
	return latestSourceDocument(documents);
}

export function getSigningBlockedAllowedActions(status: Envelope["status"]): string[] {
	return getEnvelopeAllowedActions(status);
}

export async function declineSigning(
	token: SignerToken,
	input: DeclineSigningRequest,
): Promise<DeclineSigningResult> {
	const db = getDb();
	const events = [
		{
			envelopeId: token.envelopeId,
			recipientId: token.recipientId,
			eventType: "recipient.declined",
			message: input.reason,
		},
	];
	if (input.comment) {
		events.push({
			envelopeId: token.envelopeId,
			recipientId: token.recipientId,
			eventType: "recipient.comment",
			message: input.comment,
		});
	}
	await db.insert(auditEvents).values(events).returning();
	await db
		.update(envelopeRecipients)
		.set({ status: "declined" })
		.where(eq(envelopeRecipients.id, token.recipientId));
	await db.update(envelopes).set({ status: "declined" }).where(eq(envelopes.id, token.envelopeId));

	return {
		envelopeId: token.envelopeId,
		recipientId: token.recipientId,
		recipientStatus: "declined",
		envelopeStatus: "declined",
	};
}

async function getLatestSignaturePreferenceForEmail(email: string) {
	const db = getDb();
	const normalizedEmail = normalizeSignatureProfileActor(email);
	const profiles = (
		await db
			.select()
			.from(signatureProfiles)
			.where(eq(signatureProfiles.createdBy, normalizedEmail))
			.limit(100)
	).map((profile) => SignatureProfileSchema.parse(profile));
	return (
		profiles
			.filter(
				(profile) =>
					normalizeSignatureProfileActor(profile.createdBy) === normalizedEmail && profile.selected,
			)
			.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
	);
}

function latestSourceDocument(documents: SourceDocument[]): SourceDocument | null {
	return [...documents].sort((left, right) => right.version - left.version)[0] ?? null;
}

function normalizeSignatureProfileActor(actor: string): string {
	return actor.trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export {
	completeSigning,
	SigningCompletionBlockedError,
	SigningFinalizationError,
	SigningNoAssignedFieldsError,
} from "./signing-completion";
