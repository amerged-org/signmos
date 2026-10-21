import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/setup";
import { validateSourcePdf } from "./pdf-policy";
import { EnvelopeSchema, type SourceDocument, SourceDocumentSchema } from "./schema";
import {
	auditEvents,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	idempotencyRecords,
	signerTokens,
	sourceDocuments,
} from "./table";

const uploadSourcePdfOperation = "source-pdf.upload";

export class SourcePdfUploadError extends Error {
	constructor(
		public readonly code: "DUPLICATE_SOURCE_PDF" | "ENVELOPE_NOT_DRAFT",
		message: string,
	) {
		super(message);
		this.name = "SourcePdfUploadError";
	}
}

interface UploadSourcePdfInput {
	envelopeId: string;
	uploadedBy: string;
	idempotencyKey?: string;
	bytes: Uint8Array;
	sha256: string;
	contentType: "application/pdf";
	originalFilename: string;
	documentsBucket: R2Bucket;
}

export interface UploadSourcePdfResult {
	document: SourceDocument;
	reused: boolean;
	revision: boolean;
}

export async function uploadSourcePdfDocument(
	input: UploadSourcePdfInput,
): Promise<UploadSourcePdfResult> {
	const db = getDb();

	if (input.idempotencyKey) {
		const reused = await findIdempotentSourceUpload(input);
		if (reused) return { document: reused, reused: true, revision: reused.version > 1 };
	}

	const [envelopeRow] = await db
		.select()
		.from(envelopes)
		.where(eq(envelopes.id, input.envelopeId))
		.limit(1);
	const envelope = envelopeRow ? EnvelopeSchema.parse(envelopeRow) : null;
	if (!envelope) throw new Error("Envelope not found");
	if (envelope.status !== "draft" && envelope.status !== "changes_requested") {
		throw new SourcePdfUploadError("ENVELOPE_NOT_DRAFT", "Envelope must be draft");
	}

	const existingDocuments = (
		await db
			.select()
			.from(sourceDocuments)
			.where(eq(sourceDocuments.envelopeId, input.envelopeId))
			.limit(100)
	).map((document) => SourceDocumentSchema.parse(document));
	const revision = envelope.status === "changes_requested";
	if (!revision && existingDocuments.length > 0) {
		throw new SourcePdfUploadError("DUPLICATE_SOURCE_PDF", "Envelope already has a source PDF");
	}

	const version = revision ? nextVersion(existingDocuments) : 1;
	await validateSourcePdf(input.bytes);
	const r2Key = `envelopes/${input.envelopeId}/source-v${version}.pdf`;
	await input.documentsBucket.put(r2Key, input.bytes, {
		httpMetadata: { contentType: input.contentType },
	});

	const [documentRow] = await db
		.insert(sourceDocuments)
		.values({
			envelopeId: input.envelopeId,
			r2Key,
			version,
			sha256: input.sha256,
			byteSize: input.bytes.byteLength,
			contentType: input.contentType,
			originalFilename: input.originalFilename,
			uploadedBy: input.uploadedBy,
		})
		.returning();
	if (!documentRow) throw new Error("Failed to attach source document");
	const document = SourceDocumentSchema.parse(documentRow);

	if (revision) {
		await db.delete(envelopeFields).where(eq(envelopeFields.envelopeId, input.envelopeId));
		await db.delete(fieldValues).where(eq(fieldValues.envelopeId, input.envelopeId));
		await db
			.update(envelopeRecipients)
			.set({ status: "pending" })
			.where(eq(envelopeRecipients.envelopeId, input.envelopeId));
		await db
			.update(signerTokens)
			.set({ status: "revoked" })
			.where(eq(signerTokens.envelopeId, input.envelopeId));
		await db.update(envelopes).set({ status: "draft" }).where(eq(envelopes.id, input.envelopeId));
	}

	await db
		.insert(auditEvents)
		.values({
			envelopeId: input.envelopeId,
			recipientId: null,
			eventType: revision ? "source_pdf.revised" : "source_pdf.uploaded",
			message: input.uploadedBy,
		})
		.returning();

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

	return { document, reused: false, revision };
}

export async function getLatestSourcePdfDocument(
	envelopeId: string,
): Promise<SourceDocument | null> {
	const db = getDb();
	const documents = (
		await db
			.select()
			.from(sourceDocuments)
			.where(eq(sourceDocuments.envelopeId, envelopeId))
			.limit(100)
	).map((document) => SourceDocumentSchema.parse(document));
	return latestDocument(documents);
}

export async function recordSourcePdfUploadRejection(input: {
	envelopeId: string;
	eventType:
		| "source_pdf.upload_rejected"
		| "source_pdf.upload_too_large"
		| "source_pdf.upload_duplicate";
	message: string;
}): Promise<void> {
	const db = getDb();
	await db
		.insert(auditEvents)
		.values({
			envelopeId: input.envelopeId,
			recipientId: null,
			eventType: input.eventType,
			message: input.message,
		})
		.returning();
}

async function findIdempotentSourceUpload(input: {
	envelopeId: string;
	uploadedBy: string;
	idempotencyKey?: string;
}): Promise<SourceDocument | null> {
	if (!input.idempotencyKey) return null;
	const db = getDb();
	const records = await db
		.select()
		.from(idempotencyRecords)
		.where(
			and(
				eq(idempotencyRecords.key, input.idempotencyKey),
				eq(idempotencyRecords.operation, uploadSourcePdfOperation),
				eq(idempotencyRecords.createdBy, input.uploadedBy),
			),
		)
		.limit(10);
	const record = records.find(
		(candidate) =>
			candidate.key === input.idempotencyKey &&
			candidate.operation === uploadSourcePdfOperation &&
			candidate.createdBy === input.uploadedBy,
	);
	if (!record) return null;

	const documents = (
		await db
			.select()
			.from(sourceDocuments)
			.where(eq(sourceDocuments.envelopeId, input.envelopeId))
			.limit(100)
	).map((document) => SourceDocumentSchema.parse(document));
	return latestDocument(documents);
}

function nextVersion(documents: SourceDocument[]): number {
	const latest = latestDocument(documents);
	return latest ? latest.version + 1 : 1;
}

function latestDocument(documents: SourceDocument[]): SourceDocument | null {
	return [...documents].sort((left, right) => right.version - left.version)[0] ?? null;
}
