import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/setup";
import { assertPdfFieldCount } from "./pdf-policy";
import {
	type AddFieldsRequest,
	type AddRecipientsRequest,
	type AttachSourceDocumentInput,
	type CreateEnvelopeInput,
	type Envelope,
	type EnvelopeField,
	EnvelopeFieldSchema,
	EnvelopeSchema,
	type Recipient,
	type RecipientCreateInput,
	RecipientSchema,
	type SourceDocument,
	SourceDocumentSchema,
} from "./schema";
import {
	envelopeFields,
	envelopeRecipients,
	envelopes,
	idempotencyRecords,
	sourceDocuments,
} from "./table";

const createEnvelopeOperation = "envelope.create";
const uploadSourcePdfOperation = "source-pdf.upload";

export interface CreateEnvelopeResult {
	envelope: Envelope;
	reused: boolean;
}

export interface AttachSourceDocumentResult {
	document: SourceDocument;
	reused: boolean;
}

export class SignaturePlaceholderLimitError extends Error {
	constructor() {
		super("Each signer can have one signature placeholder");
		this.name = "SignaturePlaceholderLimitError";
	}
}

export async function createEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult> {
	const db = getDb();
	if (input.idempotencyKey) {
		const [record] = await db
			.select()
			.from(idempotencyRecords)
			.where(
				and(
					eq(idempotencyRecords.key, input.idempotencyKey),
					eq(idempotencyRecords.operation, createEnvelopeOperation),
					eq(idempotencyRecords.createdBy, input.createdBy),
				),
			)
			.limit(1);
		if (record) {
			const [envelope] = await db
				.select()
				.from(envelopes)
				.where(eq(envelopes.id, record.envelopeId))
				.limit(1);
			if (!envelope) throw new Error("Idempotent envelope result not found");
			return { envelope: EnvelopeSchema.parse(envelope), reused: true };
		}
	}

	const [envelope] = await db
		.insert(envelopes)
		.values({ createdBy: input.createdBy, status: "draft" })
		.returning();
	if (!envelope) throw new Error("Failed to create envelope");

	if (input.idempotencyKey) {
		await db
			.insert(idempotencyRecords)
			.values({
				key: input.idempotencyKey,
				operation: createEnvelopeOperation,
				createdBy: input.createdBy,
				envelopeId: envelope.id,
			})
			.returning();
	}

	return { envelope: EnvelopeSchema.parse(envelope), reused: false };
}

export async function attachSourceDocument(
	input: AttachSourceDocumentInput,
): Promise<AttachSourceDocumentResult> {
	const db = getDb();
	const [envelope] = await db
		.select()
		.from(envelopes)
		.where(eq(envelopes.id, input.envelopeId))
		.limit(1);
	const parsedEnvelope = envelope ? EnvelopeSchema.parse(envelope) : null;
	if (!parsedEnvelope) throw new Error("Envelope not found");
	if (parsedEnvelope.status !== "draft") throw new Error("Envelope must be draft");

	if (input.idempotencyKey) {
		const [record] = await db
			.select()
			.from(idempotencyRecords)
			.where(
				and(
					eq(idempotencyRecords.key, input.idempotencyKey),
					eq(idempotencyRecords.operation, uploadSourcePdfOperation),
					eq(idempotencyRecords.createdBy, input.uploadedBy),
				),
			)
			.limit(1);
		if (record) {
			const [document] = await db
				.select()
				.from(sourceDocuments)
				.where(eq(sourceDocuments.envelopeId, record.envelopeId))
				.limit(1);
			if (!document) throw new Error("Idempotent source document result not found");
			return { document: SourceDocumentSchema.parse(document), reused: true };
		}
	}

	const [document] = await db
		.insert(sourceDocuments)
		.values({
			envelopeId: input.envelopeId,
			r2Key: input.r2Key,
			sha256: input.sha256,
			byteSize: input.byteSize,
			contentType: input.contentType,
			originalFilename: input.originalFilename,
			uploadedBy: input.uploadedBy,
		})
		.returning();
	if (!document) throw new Error("Failed to attach source document");

	if (input.idempotencyKey) {
		await db
			.insert(idempotencyRecords)
			.values({
				key: input.idempotencyKey,
				operation: uploadSourcePdfOperation,
				createdBy: input.uploadedBy,
				envelopeId: input.envelopeId,
			})
			.returning();
	}

	return { document: SourceDocumentSchema.parse(document), reused: false };
}

export async function addRecipients(
	envelopeId: string,
	input: AddRecipientsRequest,
): Promise<Recipient[]> {
	const db = getDb();
	await assertDraftEnvelope(envelopeId);

	const rows = await db
		.insert(envelopeRecipients)
		.values(
			input.recipients.map((recipient) => ({
				envelopeId,
				name: recipient.name,
				email: recipient.email,
				status: "pending",
			})),
		)
		.returning();
	return rows.map((recipient) => RecipientSchema.parse(recipient));
}

export async function listRecipients(envelopeId: string): Promise<Recipient[]> {
	const db = getDb();
	return (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, envelopeId))
			.limit(10)
	).map((recipient) => RecipientSchema.parse(recipient));
}

export async function updateRecipient(
	envelopeId: string,
	recipientId: string,
	input: RecipientCreateInput,
): Promise<Recipient> {
	const db = getDb();
	await assertDraftEnvelope(envelopeId);
	const recipient = await getRecipientInEnvelope(envelopeId, recipientId);
	if (!recipient) throw new Error("Recipient not found");
	await db
		.update(envelopeRecipients)
		.set({ name: input.name, email: input.email })
		.where(
			and(eq(envelopeRecipients.id, recipientId), eq(envelopeRecipients.envelopeId, envelopeId)),
		);
	return RecipientSchema.parse({ ...recipient, name: input.name, email: input.email });
}

export async function deleteRecipient(envelopeId: string, recipientId: string): Promise<Recipient> {
	const db = getDb();
	await assertDraftEnvelope(envelopeId);
	const recipient = await getRecipientInEnvelope(envelopeId, recipientId);
	if (!recipient) throw new Error("Recipient not found");
	await db.delete(envelopeFields).where(eq(envelopeFields.recipientId, recipientId));
	await db
		.delete(envelopeRecipients)
		.where(
			and(eq(envelopeRecipients.id, recipientId), eq(envelopeRecipients.envelopeId, envelopeId)),
		);
	return recipient;
}

export async function addFields(
	envelopeId: string,
	input: AddFieldsRequest,
): Promise<EnvelopeField[]> {
	const db = getDb();
	const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(1);
	const parsedEnvelope = envelope ? EnvelopeSchema.parse(envelope) : null;
	if (!parsedEnvelope) throw new Error("Envelope not found");
	if (parsedEnvelope.status !== "draft") throw new Error("Envelope must be draft");

	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, envelopeId))
			.limit(10)
	).map((recipient) => RecipientSchema.parse(recipient));
	const recipientIds = new Set(recipients.map((recipient) => recipient.id));
	if (input.fields.some((field) => !recipientIds.has(field.recipientId))) {
		throw new Error("Field recipient not found");
	}

	const existingFields = await listEnvelopeFields(envelopeId);
	assertPdfFieldCount(existingFields.length + input.fields.length);
	const signatureRecipientIds = new Set(
		existingFields.filter((field) => field.type === "signature").map((field) => field.recipientId),
	);
	for (const field of input.fields) {
		if (field.type !== "signature") continue;
		if (signatureRecipientIds.has(field.recipientId)) {
			throw new SignaturePlaceholderLimitError();
		}
		signatureRecipientIds.add(field.recipientId);
	}

	const rows = await db
		.insert(envelopeFields)
		.values(input.fields.map((field) => ({ ...field, envelopeId })))
		.returning();
	return rows.map((field) => EnvelopeFieldSchema.parse(field));
}

export async function listEnvelopeFields(envelopeId: string): Promise<EnvelopeField[]> {
	const db = getDb();
	return (
		await db
			.select()
			.from(envelopeFields)
			.where(eq(envelopeFields.envelopeId, envelopeId))
			.limit(100)
	).map((field) => EnvelopeFieldSchema.parse(field));
}

async function assertDraftEnvelope(envelopeId: string): Promise<void> {
	const db = getDb();
	const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(1);
	const parsedEnvelope = envelope ? EnvelopeSchema.parse(envelope) : null;
	if (!parsedEnvelope) throw new Error("Envelope not found");
	if (parsedEnvelope.status !== "draft") throw new Error("Envelope must be draft");
}

async function getRecipientInEnvelope(
	envelopeId: string,
	recipientId: string,
): Promise<Recipient | null> {
	return (
		(await listRecipients(envelopeId)).find((recipient) => recipient.id === recipientId) ?? null
	);
}
