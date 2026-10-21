import { eq, getTableColumns, sql } from "drizzle-orm";
import { getDb } from "@/db/setup";
import {
	finalizationSnapshotProjection,
	parseFinalizationSnapshotProjection,
} from "./finalization";
import {
	type EnvelopeField,
	EnvelopeFieldSchema,
	EnvelopeSchema,
	type FinalDocument,
	FinalDocumentSchema,
	type Recipient,
	RecipientSchema,
	SignerTokenSchema,
} from "./schema";
import { noEnvelopeDeletion, signingBatch } from "./signing-batch";
import {
	auditEvents,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	signerTokens,
} from "./table";

export interface CompletedDocumentLink {
	url: string;
	downloadUrl: string;
}

export interface CompletedDocumentView {
	token: string;
	envelopeId: string;
	status: "completed";
	finalPdf: {
		downloadUrl: string;
		contentType: "application/pdf";
		byteSize: number;
		sha256: string;
		createdAt: string | null;
	};
	parties: CompletedDocumentParty[];
	history: CompletedDocumentHistoryEvent[];
}

interface CompletedDocumentParty {
	id: string;
	name: string;
	email: string;
	status: string;
	signedDate: string | null;
	signedAt: string | null;
}

export interface CompletedDocumentHistoryEvent {
	type: string;
	title: string;
	detail: string | null;
	occurredAt: string;
}

interface FieldValueSnapshot {
	recipientId: string;
	fieldId: string;
	value: string;
	completedAt: Date | null;
}

interface CompletedDocumentContext {
	finalDocument: FinalDocument;
	recipients: Recipient[];
	fields: EnvelopeField[];
	values: FieldValueSnapshot[];
	events: Array<Record<string, unknown>>;
}

export async function getCompletedDocumentView(
	token: string,
	options: { now?: Date } = {},
): Promise<CompletedDocumentView | null> {
	const context = await getCompletedDocumentContext(token, options);
	if (!context) return null;

	return {
		token,
		envelopeId: context.finalDocument.envelopeId,
		status: "completed",
		finalPdf: {
			downloadUrl: completedDocumentDownloadUrl(token),
			contentType: context.finalDocument.contentType,
			byteSize: context.finalDocument.byteSize,
			sha256: context.finalDocument.sha256,
			createdAt: context.finalDocument.createdAt?.toISOString() ?? null,
		},
		parties: buildParties(context),
		history: buildHistory(context),
	};
}

export async function getPublicEnvelopeHistory(
	envelopeId: string,
): Promise<CompletedDocumentHistoryEvent[]> {
	const db = getDb();
	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, envelopeId))
			.limit(100)
	).map((recipient) => RecipientSchema.parse(recipient));
	const events = await db
		.select()
		.from(auditEvents)
		.where(eq(auditEvents.envelopeId, envelopeId))
		.limit(100);
	return buildHistory({ recipients, events });
}

export async function getFinalDocumentByToken(
	token: string,
	options: { now?: Date } = {},
): Promise<FinalDocument | null> {
	return (await getFinalDocumentDownloadContext(token, options))?.document ?? null;
}

export async function getFinalDocumentDownloadContext(token: string, options: { now?: Date } = {}) {
	const db = getDb();
	const [row] = await db
		.select({
			...getTableColumns(finalDocuments),
			finalizationData: finalizationSnapshotProjection(sql`final_documents.envelope_id`),
		})
		.from(finalDocuments)
		.where(sql`${noEnvelopeDeletion(sql`final_documents.envelope_id`)}
		and exists (select 1 from envelopes e where e.id = final_documents.envelope_id and e.status = 'completed')
		and (final_documents.id::text = ${token} or exists (select 1 from signer_tokens t where t.envelope_id = final_documents.envelope_id and t.token = ${token} and t.status = 'active' and t.expires_at > ${options.now ?? new Date()}))`)
		.limit(1);
	if (!row) return null;
	const document = FinalDocumentSchema.parse(row);
	return {
		document,
		snapshot: parseFinalizationSnapshotProjection(row.finalizationData),
		access: sql`${noEnvelopeDeletion(document.envelopeId)} and exists (select 1 from envelopes e where e.id = ${document.envelopeId} and e.status = 'completed')
			and (${document.id ?? null}::text = ${token} or exists (select 1 from signer_tokens t where t.envelope_id = ${document.envelopeId} and t.token = ${token} and t.status = 'active' and t.expires_at > ${options.now ?? new Date()}))`,
	};
}

export async function getCompletedDocumentLinkForSignerToken(
	tokenValue: string,
	options: { now?: Date } = {},
): Promise<CompletedDocumentLink | null> {
	const db = getDb();
	const [tokenRows = []] = await signingBatch([
		{
			table: signerTokens,
			query: db.select().from(signerTokens).where(eq(signerTokens.token, tokenValue)).limit(1),
		},
	]);
	const token =
		tokenRows.map((row) => SignerTokenSchema.parse(row)).find((row) => row.token === tokenValue) ??
		null;
	if (!token || token.status !== "active" || token.expiresAt <= (options.now ?? new Date()))
		return null;
	const [envelopeRows = [], documents = []] = await signingBatch([
		{
			table: envelopes,
			query: db
				.select()
				.from(envelopes)
				.where(
					sql`${envelopes.id} = ${token.envelopeId} and ${noEnvelopeDeletion(token.envelopeId)}`,
				)
				.limit(1),
		},
		{
			table: finalDocuments,
			query: db
				.select()
				.from(finalDocuments)
				.where(eq(finalDocuments.envelopeId, token.envelopeId))
				.limit(1),
		},
	]);
	if (!envelopeRows[0] || EnvelopeSchema.parse(envelopeRows[0]).status !== "completed") return null;
	const finalDocument =
		documents
			.map((row) => FinalDocumentSchema.parse(row))
			.find((document) => document.envelopeId === token.envelopeId && document.id) ?? null;

	if (!finalDocument?.id) return null;
	return completedDocumentLink(token.token);
}

function completedDocumentLink(token: string): CompletedDocumentLink {
	return {
		url: `/completed-documents/${token}`,
		downloadUrl: completedDocumentDownloadUrl(token),
	};
}

function completedDocumentDownloadUrl(token: string): string {
	return `/api/final-documents/${token}/pdf`;
}

async function getCompletedDocumentContext(
	token: string,
	options: { now?: Date } = {},
): Promise<CompletedDocumentContext | null> {
	const db = getDb();
	const [tokenRows = [], directDocuments = []] = await signingBatch([
		{
			table: signerTokens,
			query: db.select().from(signerTokens).where(eq(signerTokens.token, token)).limit(1),
		},
		{
			table: finalDocuments,
			query: db
				.select()
				.from(finalDocuments)
				.where(sql`${finalDocuments.id}::text = ${token}`)
				.limit(1),
		},
	]);
	const signer = tokenRows
		.map((row) => SignerTokenSchema.parse(row))
		.find((row) => row.token === token);
	if (signer && (signer.status !== "active" || signer.expiresAt <= (options.now ?? new Date())))
		return null;
	const direct = directDocuments
		.map((row) => FinalDocumentSchema.parse(row))
		.find((row) => row.id === token);
	const envelopeId = signer?.envelopeId ?? direct?.envelopeId;
	if (!envelopeId) return null;
	const [
		envelopeRows = [],
		documents = [],
		recipientRows = [],
		fieldRows = [],
		valueRows = [],
		events = [],
	] = await signingBatch([
		{
			table: envelopes,
			query: db
				.select()
				.from(envelopes)
				.where(sql`${envelopes.id} = ${envelopeId} and ${noEnvelopeDeletion(envelopeId)}`)
				.limit(1),
		},
		{
			table: finalDocuments,
			query: db
				.select()
				.from(finalDocuments)
				.where(eq(finalDocuments.envelopeId, envelopeId))
				.limit(1),
		},
		{
			table: envelopeRecipients,
			query: db
				.select()
				.from(envelopeRecipients)
				.where(eq(envelopeRecipients.envelopeId, envelopeId))
				.limit(100),
		},
		{
			table: envelopeFields,
			query: db
				.select()
				.from(envelopeFields)
				.where(eq(envelopeFields.envelopeId, envelopeId))
				.limit(100),
		},
		{
			table: fieldValues,
			query: db.select().from(fieldValues).where(eq(fieldValues.envelopeId, envelopeId)).limit(100),
		},
		{
			table: auditEvents,
			query: db.select().from(auditEvents).where(eq(auditEvents.envelopeId, envelopeId)).limit(100),
		},
	]);
	if (!envelopeRows[0] || EnvelopeSchema.parse(envelopeRows[0]).status !== "completed") return null;
	const finalDocument = documents
		.map((row) => FinalDocumentSchema.parse(row))
		.find((row) => row.envelopeId === envelopeId);
	if (!finalDocument) return null;
	const recipients = recipientRows.map((row) => RecipientSchema.parse(row));
	const fields = fieldRows.map((row) => EnvelopeFieldSchema.parse(row));
	const values = valueRows
		.map(normalizeFieldValue)
		.filter((value): value is FieldValueSnapshot => Boolean(value));
	return { finalDocument, recipients, fields, values, events };
}

function buildParties(context: CompletedDocumentContext | null) {
	if (!context) return [];
	const dateFieldIdsByRecipient = new Map(
		context.fields
			.filter((field) => field.type === "date")
			.map((field) => [field.recipientId, field.id]),
	);
	return context.recipients.map((recipient) => {
		const recipientValues = context.values.filter((value) => value.recipientId === recipient.id);
		const dateFieldId = dateFieldIdsByRecipient.get(recipient.id);
		const signedDate =
			recipientValues.find((value) => value.fieldId === dateFieldId)?.value ?? null;
		const signedAt = latestDate(recipientValues.map((value) => value.completedAt));
		return {
			id: recipient.id,
			name: recipient.name,
			email: recipient.email,
			status: recipient.status,
			signedDate,
			signedAt: signedAt?.toISOString() ?? null,
		};
	});
}

function buildHistory(
	context: Pick<CompletedDocumentContext, "recipients" | "events"> | null,
): CompletedDocumentHistoryEvent[] {
	if (!context) return [];
	const recipientNameById = new Map(
		context.recipients.map((recipient) => [recipient.id, recipient.name]),
	);
	return context.events
		.map((event) => toPublicHistoryEvent(event as Record<string, unknown>, recipientNameById))
		.filter((event): event is CompletedDocumentHistoryEvent => Boolean(event))
		.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}

function toPublicHistoryEvent(
	event: Record<string, unknown>,
	recipientNameById: Map<string, string>,
): CompletedDocumentHistoryEvent | null {
	const eventType = stringValue(event.eventType);
	const occurredAt = dateValue(event.createdAt)?.toISOString();
	if (!occurredAt) return null;
	const recipientName = recipientNameById.get(stringValue(event.recipientId)) ?? "Signer";
	const detail = nullableString(event.message);
	const base = { detail, occurredAt };

	if (eventType === "source_pdf.uploaded") {
		return { ...base, type: "document_uploaded", title: "Document uploaded" };
	}
	if (eventType === "source_pdf.revised") {
		return { ...base, type: "document_revised", title: "Document revised" };
	}
	if (eventType === "envelope.sent") {
		return { ...base, type: "sent", title: "Envelope sent" };
	}
	if (eventType === "partner.signing.viewed") {
		return { ...base, type: "viewed", title: `${recipientName} viewed the document` };
	}
	if (eventType === "sender.completed" || eventType === "recipient.completed") {
		return { ...base, type: "signed", title: `${recipientName} signed` };
	}
	if (eventType === "partner.change_requested") {
		return { ...base, type: "changes_requested", title: `${recipientName} requested changes` };
	}
	if (eventType === "recipient.declined") {
		return { ...base, type: "declined", title: `${recipientName} declined` };
	}
	if (eventType === "envelope.canceled") {
		return { ...base, type: "canceled", title: "Envelope canceled" };
	}
	if (eventType === "envelope.expired") {
		return { ...base, type: "expired", title: "Envelope expired" };
	}
	if (eventType === "envelope.deleted") {
		return { ...base, type: "deleted", title: "Envelope deleted" };
	}
	return null;
}

function normalizeFieldValue(row: Record<string, unknown>): FieldValueSnapshot | null {
	const recipientId = stringValue(row.recipientId);
	const fieldId = stringValue(row.fieldId);
	const value = stringValue(row.value);
	if (!recipientId || !fieldId || !value) return null;
	return {
		recipientId,
		fieldId,
		value,
		completedAt: dateValue(row.completedAt),
	};
}

function latestDate(values: Array<Date | null>): Date | null {
	return (
		values
			.filter((value): value is Date => value instanceof Date)
			.sort((left, right) => right.getTime() - left.getTime())[0] ?? null
	);
}

function nullableString(value: unknown): string | null {
	const text = stringValue(value);
	return text || null;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function dateValue(value: unknown): Date | null {
	return value instanceof Date ? value : null;
}
