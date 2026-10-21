import { eq } from "drizzle-orm";
import { getDb } from "@/db/setup";
import { recordArtifactVersion } from "./artifact-versions";
import { buildCertificateMaterial, renderFinalPdf } from "./final-pdf-renderer";
import {
	type Envelope,
	EnvelopeSchema,
	type FinalDocument,
	FinalDocumentSchema,
	getEnvelopeAllowedActions,
	RecipientSchema,
	SenderVerificationTokenSchema,
	type SignerToken,
	SignerTokenSchema,
	type SourceDocument,
	SourceDocumentSchema,
} from "./schema";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	senderVerificationEmailRecords,
	senderVerificationTokens,
	signerTokens,
	sourceDocuments,
} from "./table";

interface FinalizeEnvelopeOptions {
	documentsBucket?: R2Bucket;
}

interface FinalDocumentArtifact {
	bytes: Uint8Array;
	sha256: string;
	byteSize: number;
	contentType: "application/pdf";
}

export interface EnvelopeFinalizationStatus {
	envelopeId: string;
	status: Envelope["status"];
	finalPdfAvailable: boolean;
	allowedActions: string[];
	changeRequest?: {
		comment: string;
	};
	pendingRecipients: Array<{
		id: string;
		name: string;
		email: string;
		status: "sent";
	}>;
}

export async function finalizeCompletedEnvelope(
	envelopeId: string,
	options: FinalizeEnvelopeOptions = {},
) {
	if (!options.documentsBucket) return null;

	const db = getDb();
	const [existing] = await db
		.select()
		.from(finalDocuments)
		.where(eq(finalDocuments.envelopeId, envelopeId))
		.limit(1);
	if (existing) return FinalDocumentSchema.parse(existing);
	const artifact = await renderFinalDocumentArtifact(envelopeId, options.documentsBucket);
	const r2Key = `envelopes/${envelopeId}/final/${artifact.sha256}.pdf`;
	await options.documentsBucket.put(r2Key, artifact.bytes, {
		httpMetadata: { contentType: artifact.contentType },
	});
	await recordArtifactVersion(envelopeId, r2Key);

	const [document] = await db
		.insert(finalDocuments)
		.values({
			envelopeId,
			r2Key,
			sha256: artifact.sha256,
			byteSize: artifact.byteSize,
			contentType: artifact.contentType,
		})
		.returning();
	const finalDocument = document ? FinalDocumentSchema.parse(document) : null;
	await recordCompletionNotifications(envelopeId, finalDocument?.id);
	return finalDocument;
}

export async function regenerateFinalDocumentArtifact(
	finalDocument: FinalDocument,
	options: FinalizeEnvelopeOptions = {},
): Promise<{ document: FinalDocument; bytes: Uint8Array } | null> {
	if (!options.documentsBucket) return null;
	const db = getDb();
	await recordArtifactVersion(finalDocument.envelopeId, finalDocument.r2Key);
	const artifact = await renderFinalDocumentArtifact(
		finalDocument.envelopeId,
		options.documentsBucket,
	);
	// OMH logical file names are immutable, including after deletion. Repairing an
	// older renderer's artifact therefore creates a new content-addressed version.
	const r2Key = `envelopes/${finalDocument.envelopeId}/final/${artifact.sha256}.pdf`;
	await options.documentsBucket.put(r2Key, artifact.bytes, {
		httpMetadata: { contentType: artifact.contentType },
	});
	await recordArtifactVersion(finalDocument.envelopeId, r2Key);
	if (finalDocument.id) {
		await db
			.update(finalDocuments)
			.set({
				r2Key,
				sha256: artifact.sha256,
				byteSize: artifact.byteSize,
				contentType: artifact.contentType,
			})
			.where(eq(finalDocuments.id, finalDocument.id));
	}
	return {
		document: {
			...finalDocument,
			r2Key,
			sha256: artifact.sha256,
			byteSize: artifact.byteSize,
			contentType: artifact.contentType,
		},
		bytes: artifact.bytes,
	};
}

async function renderFinalDocumentArtifact(
	envelopeId: string,
	documentsBucket: R2Bucket,
): Promise<FinalDocumentArtifact> {
	const db = getDb();
	const sourceDocumentRows = await db
		.select()
		.from(sourceDocuments)
		.where(eq(sourceDocuments.envelopeId, envelopeId))
		.limit(100);
	const sourceDocument = latestSourceDocument(
		sourceDocumentRows.map((document) => SourceDocumentSchema.parse(document)),
	);
	if (!sourceDocument) throw new Error("Envelope source PDF required");

	const rows = {
		fields: await db
			.select()
			.from(envelopeFields)
			.where(eq(envelopeFields.envelopeId, envelopeId))
			.limit(100),
		values: await db
			.select()
			.from(fieldValues)
			.where(eq(fieldValues.envelopeId, envelopeId))
			.limit(100),
		events: await db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.envelopeId, envelopeId))
			.limit(100),
	};
	const certificateHash = await sha256Hex(
		new TextEncoder().encode(buildCertificateMaterial(sourceDocument, rows)),
	);
	const sourceObject = await documentsBucket.get(sourceDocument.r2Key);
	if (!sourceObject) throw new Error("Envelope source PDF object required");
	const bytes = await renderFinalPdf({
		envelopeId,
		sourceDocument,
		rows,
		certificateHash,
		sourceBytes: new Uint8Array(await sourceObject.arrayBuffer()),
	});
	return {
		bytes,
		sha256: await sha256Hex(bytes),
		byteSize: bytes.byteLength,
		contentType: "application/pdf",
	};
}

export async function getEnvelopeFinalizationStatus(
	envelopeId: string,
): Promise<EnvelopeFinalizationStatus> {
	const db = getDb();
	const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(1);
	const parsedEnvelope = envelope ? EnvelopeSchema.parse(envelope) : null;
	if (!parsedEnvelope) throw new Error("Envelope not found");
	const [finalDocument] = await db
		.select()
		.from(finalDocuments)
		.where(eq(finalDocuments.envelopeId, envelopeId))
		.limit(1);
	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, envelopeId))
			.limit(100)
	).map((recipient) => RecipientSchema.parse(recipient));
	const changeRequest =
		parsedEnvelope.status === "changes_requested" ? await getFirstChangeRequest(envelopeId) : null;

	return {
		envelopeId,
		status: parsedEnvelope.status,
		finalPdfAvailable: parsedEnvelope.status === "completed" && Boolean(finalDocument),
		allowedActions: getEnvelopeAllowedActions(parsedEnvelope.status),
		...(changeRequest ? { changeRequest } : {}),
		pendingRecipients:
			parsedEnvelope.status === "sent"
				? recipients
						.filter((recipient) => recipient.status === "sent")
						.map((recipient) => ({
							id: recipient.id,
							name: recipient.name,
							email: recipient.email,
							status: "sent",
						}))
				: [],
	};
}

async function getFirstChangeRequest(envelopeId: string): Promise<{ comment: string } | null> {
	const db = getDb();
	const events = await db
		.select()
		.from(auditEvents)
		.where(eq(auditEvents.envelopeId, envelopeId))
		.limit(100);
	const event = events.find(
		(row) => row.eventType === "partner.change_requested" && typeof row.message === "string",
	);
	return typeof event?.message === "string" ? { comment: event.message } : null;
}

export async function getFinalDocument(envelopeId: string): Promise<FinalDocument | null> {
	const db = getDb();
	const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(1);
	const parsedEnvelope = envelope ? EnvelopeSchema.parse(envelope) : null;
	if (!parsedEnvelope || parsedEnvelope.status !== "completed") return null;

	const [document] = await db
		.select()
		.from(finalDocuments)
		.where(eq(finalDocuments.envelopeId, envelopeId))
		.limit(1);
	return document ? FinalDocumentSchema.parse(document) : null;
}

export async function getSignerFinalDocument(token: SignerToken): Promise<FinalDocument | null> {
	return getFinalDocument(token.envelopeId);
}

async function recordCompletionNotifications(
	envelopeId: string,
	finalDocumentToken: string | undefined,
): Promise<void> {
	if (!finalDocumentToken) return;
	const db = getDb();
	const completedDocumentUrl = `/completed-documents/${finalDocumentToken}`;
	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, envelopeId))
			.limit(100)
	).map((recipient) => RecipientSchema.parse(recipient));
	const tokens = (
		await db.select().from(signerTokens).where(eq(signerTokens.envelopeId, envelopeId)).limit(100)
	).map((token) => SignerTokenSchema.parse(token));
	const partnerRecords = recipients.flatMap((recipient) => {
		const token = latestSignerToken(tokens, recipient.id);
		if (!token) return [];
		return [
			{
				envelopeId,
				recipientId: recipient.id,
				tokenId: token.id,
				email: recipient.email,
				kind: "completion",
				fallbackUrl: `/completed-documents/${token.token}`,
			},
		];
	});
	if (partnerRecords.length > 0) {
		await db.insert(emailSendRecords).values(partnerRecords).returning();
	}

	const senderTokens = (
		await db
			.select()
			.from(senderVerificationTokens)
			.where(eq(senderVerificationTokens.envelopeId, envelopeId))
			.limit(100)
	).map((token) => SenderVerificationTokenSchema.parse(token));
	const senderToken = latestVerifiedSenderToken(senderTokens);
	if (senderToken) {
		await db
			.insert(senderVerificationEmailRecords)
			.values({
				envelopeId,
				tokenId: senderToken.id,
				email: senderToken.email,
				kind: "completion",
				fallbackUrl: completedDocumentUrl,
			})
			.returning();
	}
}

function latestSourceDocument(documents: SourceDocument[]): SourceDocument | null {
	return [...documents].sort((left, right) => right.version - left.version)[0] ?? null;
}

function latestSignerToken(
	tokens: ReturnType<typeof SignerTokenSchema.parse>[],
	recipientId: string,
) {
	return [...tokens]
		.filter((token) => token.status === "active" && token.recipientId === recipientId)
		.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
}

function latestVerifiedSenderToken(
	tokens: ReturnType<typeof SenderVerificationTokenSchema.parse>[],
) {
	return [...tokens]
		.filter((token) => token.status === "verified")
		.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	const hash = await crypto.subtle.digest("SHA-256", buffer);
	return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
