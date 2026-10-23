import { eq, type SQL, sql } from "drizzle-orm";
import { getDb } from "@/db/setup";
import { envelopeArtifactVersions } from "./artifact-versions";
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
	decodeSigningRow,
	noEnvelopeDeletion,
	type SigningBatchQuery,
	signingBatch,
	signingStatement,
} from "./signing-batch";
import {
	auditEvents,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	senderVerificationTokens,
	signerTokens,
	sourceDocuments,
} from "./table";

interface FinalizeEnvelopeOptions {
	documentsBucket?: R2Bucket;
	access?: SQL;
	snapshot?: SigningFinalizationSnapshot;
	completion?: { token: SignerToken; now: Date; owner?: string; recipientEmail?: string };
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

	const snapshot = options.snapshot ?? (await getSigningFinalizationSnapshot(envelopeId));
	if (snapshot.existing) {
		if (!options.completion) return snapshot.existing;
		return commitFinalArtifact(
			envelopeId,
			snapshot.existing.r2Key,
			{ bytes: new Uint8Array(), ...snapshot.existing },
			snapshot,
			options.completion,
		);
	}
	const artifact = await renderFinalDocumentArtifact(envelopeId, options.documentsBucket, snapshot);
	const r2Key = newFinalArtifactKey(envelopeId, artifact.sha256);
	await registerFinalArtifact(envelopeId, r2Key, snapshot, options.completion);
	await options.documentsBucket.put(r2Key, artifact.bytes, {
		httpMetadata: { contentType: artifact.contentType },
	});
	return commitFinalArtifact(envelopeId, r2Key, artifact, snapshot, options.completion);
}

/**
 * Every attempt to store a final PDF uses a name of its own. The platform reserves an upload under
 * a name for 300 s and refuses to replay it once less than 60 s remain and no bytes landed (409
 * upload_expired, "needs a new objectKey and idempotencyKey"), and no other upload may take that
 * name. An attempt that failed after its reservation, retried by the signer or a download link
 * hours later, would therefore meet the dead reservation for ever. A fresh name cannot. Each name
 * is retained before its upload (registerFinalArtifact), so the names of failed attempts are erased
 * with the rest when the contract is deleted.
 */
function newFinalArtifactKey(envelopeId: string, sha256: string): string {
	return `envelopes/${envelopeId}/final/${sha256}-${crypto.randomUUID()}.pdf`;
}

export interface SigningFinalizationSnapshot {
	existing: FinalDocument | null;
	sourceDocument: SourceDocument | null;
	rows: {
		fields: Array<Record<string, unknown>>;
		values: Array<Record<string, unknown>>;
		events: Array<Record<string, unknown>>;
	};
	recipients: ReturnType<typeof RecipientSchema.parse>[];
	tokens: SignerToken[];
	senderTokens: ReturnType<typeof SenderVerificationTokenSchema.parse>[];
}

export async function getSigningFinalizationSnapshot(
	envelopeId: string,
	writes: SigningBatchQuery[] = [],
): Promise<SigningFinalizationSnapshot> {
	const db = getDb();
	const tables = [
		finalDocuments,
		sourceDocuments,
		envelopeFields,
		fieldValues,
		auditEvents,
		envelopeRecipients,
		signerTokens,
		senderVerificationTokens,
	] as const;
	const results = await signingBatch([
		...writes,
		...tables.map((table) => ({
			table,
			query: db.select().from(table).where(eq(table.envelopeId, envelopeId)).limit(100),
		})),
	]);
	const [
		finalRows = [],
		sources = [],
		fields = [],
		values = [],
		events = [],
		recipients = [],
		tokens = [],
		senderTokens = [],
	] = results.slice(writes.length);
	return {
		existing: finalRows[0] ? FinalDocumentSchema.parse(finalRows[0]) : null,
		sourceDocument: latestSourceDocument(sources.map((row) => SourceDocumentSchema.parse(row))),
		rows: { fields, values, events },
		recipients: recipients.map((row) => RecipientSchema.parse(row)),
		tokens: tokens.map((row) => SignerTokenSchema.parse(row)),
		senderTokens: senderTokens.map((row) => SenderVerificationTokenSchema.parse(row)),
	};
}

export function finalizationSnapshotProjection(
	envelopeId: ReturnType<typeof sql>,
): ReturnType<typeof sql<Record<string, unknown>>> {
	return sql<Record<string, unknown>>`jsonb_build_object(
		'sources', coalesce((select jsonb_agg(to_jsonb(s)) from (select * from source_documents where envelope_id = ${envelopeId} limit 100) s), '[]'::jsonb),
		'fields', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from envelope_fields where envelope_id = ${envelopeId} limit 100) f), '[]'::jsonb),
		'values', coalesce((select jsonb_agg(to_jsonb(v)) from (select * from field_values where envelope_id = ${envelopeId} limit 100) v), '[]'::jsonb),
		'events', coalesce((select jsonb_agg(to_jsonb(a)) from (select * from audit_events where envelope_id = ${envelopeId} limit 100) a), '[]'::jsonb),
		'recipients', coalesce((select jsonb_agg(to_jsonb(r)) from (select * from envelope_recipients where envelope_id = ${envelopeId} limit 100) r), '[]'::jsonb),
		'tokens', coalesce((select jsonb_agg(to_jsonb(t)) from (select * from signer_tokens where envelope_id = ${envelopeId} limit 100) t), '[]'::jsonb),
		'senderTokens', coalesce((select jsonb_agg(to_jsonb(t)) from (select * from sender_verification_tokens where envelope_id = ${envelopeId} limit 100) t), '[]'::jsonb))`;
}

export function parseFinalizationSnapshotProjection(
	data: Record<string, unknown>,
): SigningFinalizationSnapshot {
	const rows = (key: string, table: Parameters<typeof decodeSigningRow>[0]) => {
		const raw = data[key];
		if (!Array.isArray(raw)) throw new Error("Incomplete final document snapshot");
		return raw.map((row: Record<string, unknown>) => decodeSigningRow(table, row));
	};
	return {
		existing: null,
		sourceDocument: latestSourceDocument(
			rows("sources", sourceDocuments).map((row) => SourceDocumentSchema.parse(row)),
		),
		rows: {
			fields: rows("fields", envelopeFields),
			values: rows("values", fieldValues),
			events: rows("events", auditEvents),
		},
		recipients: rows("recipients", envelopeRecipients).map((row) => RecipientSchema.parse(row)),
		tokens: rows("tokens", signerTokens).map((row) => SignerTokenSchema.parse(row)),
		senderTokens: rows("senderTokens", senderVerificationTokens).map((row) =>
			SenderVerificationTokenSchema.parse(row),
		),
	};
}

function finalArtifactGuard(
	envelopeId: string,
	snapshot: SigningFinalizationSnapshot,
	completion?: FinalizeEnvelopeOptions["completion"],
	access?: SQL,
) {
	const source = snapshot.sourceDocument;
	const token = completion?.token;
	return sql`exists (select 1 from envelopes e where e.id = ${envelopeId}
		and e.status in ('sent', 'completed') and ${noEnvelopeDeletion(envelopeId)} ${access ? sql`and (${access})` : sql``}
		${completion?.owner ? sql`and e.created_by = ${completion.owner}` : sql``}
		and exists (select 1 from source_documents s where s.envelope_id = e.id and s.id = ${source?.id ?? null} and s.sha256 = ${source?.sha256 ?? null}
			and not exists (select 1 from source_documents newer where newer.envelope_id = e.id and newer.version > s.version))
		${
			token
				? sql`and exists (select 1 from signer_tokens t where t.id = ${token.id} and t.envelope_id = e.id and t.recipient_id = ${token.recipientId} and t.token = ${token.token}
			and t.status = 'active' and t.verified_at is not null and t.expires_at > ${completion.now})
			and exists (select 1 from envelope_recipients current_recipient where current_recipient.id = ${token.recipientId} and current_recipient.envelope_id = e.id ${completion.recipientEmail ? sql`and current_recipient.email = ${completion.recipientEmail}` : sql``})
			and not exists (select 1 from envelope_recipients r where r.envelope_id = e.id and r.status <> 'completed')`
				: sql``
		})`;
}

async function registerFinalArtifact(
	envelopeId: string,
	r2Key: string,
	snapshot: SigningFinalizationSnapshot,
	completion?: FinalizeEnvelopeOptions["completion"],
	previousR2Key?: string,
	access?: SQL,
) {
	const db = getDb();
	const result =
		(
			await signingBatch([
				signingStatement(sql`select id from envelopes where id = ${envelopeId} for update`),
				...(previousR2Key
					? [
							db
								.insert(envelopeArtifactVersions)
								.values({ envelopeId, r2Key: previousR2Key })
								.onConflictDoNothing(),
						]
					: []),
				signingStatement(sql`/* signing-register-artifact */
		with locked as (select id from envelopes where id = ${envelopeId} for update),
		retained as (insert into envelope_artifact_versions (envelope_id, r2_key)
			select locked.id, ${r2Key} from locked where ${finalArtifactGuard(envelopeId, snapshot, completion, access)}
			on conflict (r2_key) do update set r2_key = excluded.r2_key returning id)
		select id from retained`),
			])
		).at(-1) ?? [];
	if (result.length !== 1) throw new Error("Document changed before final PDF retention");
}

async function commitFinalArtifact(
	envelopeId: string,
	r2Key: string,
	artifact: FinalDocumentArtifact,
	snapshot: SigningFinalizationSnapshot,
	completion?: FinalizeEnvelopeOptions["completion"],
) {
	const documentId = crypto.randomUUID();
	const guard = finalArtifactGuard(envelopeId, snapshot, completion);
	const notificationWrites = snapshot.recipients.flatMap((recipient) => {
		const token = latestSignerToken(snapshot.tokens, recipient.id);
		return token
			? [
					signingStatement(sql`insert into email_send_records (envelope_id, recipient_id, token_id, email, kind, fallback_url)
			select ${envelopeId}, ${recipient.id}, ${token.id}, ${recipient.email}, 'completion', ${`/completed-documents/${token.token}`}
			from final_documents where id = ${documentId}`),
				]
			: [];
	});
	const senderToken = latestVerifiedSenderToken(snapshot.senderTokens);
	if (senderToken)
		notificationWrites.push(
			signingStatement(sql`insert into sender_verification_email_records (envelope_id, token_id, email, kind, fallback_url)
		select ${envelopeId}, ${senderToken.id}, ${senderToken.email}, 'completion', ${`/completed-documents/${documentId}`}
		from final_documents where id = ${documentId}`),
		);
	const results = await signingBatch([
		signingStatement(sql`select id from envelopes where id = ${envelopeId} for update`),
		...(completion
			? [
					signingStatement(
						sql`select id from signer_tokens where id = ${completion.token.id} for update`,
					),
				]
			: []),
		signingStatement(sql`/* signing-commit-artifact */ insert into final_documents (id, envelope_id, r2_key, sha256, byte_size, content_type)
			select ${documentId}, ${envelopeId}, ${r2Key}, ${artifact.sha256}, ${artifact.byteSize}, ${artifact.contentType}
			where ${guard} and not exists (select 1 from final_documents where envelope_id = ${envelopeId}) on conflict (r2_key) do nothing`),
		...notificationWrites,
		...(completion
			? [
					signingStatement(sql`update envelopes set status = 'completed' where id = ${envelopeId} and ${guard}
			and exists (select 1 from final_documents f where f.envelope_id = ${envelopeId})`),
				]
			: []),
		signingStatement(sql`select f.* from final_documents f join envelopes e on e.id = f.envelope_id
			where e.id = ${envelopeId} and ${completion ? sql`e.status = 'completed' and ${guard}` : guard} limit 1`),
	]);
	const row = results.at(-1)?.[0];
	return row ? FinalDocumentSchema.parse(decodeSigningRow(finalDocuments, row)) : null;
}

export async function regenerateFinalDocumentArtifact(
	finalDocument: FinalDocument,
	options: FinalizeEnvelopeOptions = {},
): Promise<{ document: FinalDocument; bytes: Uint8Array } | null> {
	if (!options.documentsBucket) return null;
	const db = getDb();
	const snapshot =
		options.snapshot ?? (await getSigningFinalizationSnapshot(finalDocument.envelopeId));
	const artifact = await renderFinalDocumentArtifact(
		finalDocument.envelopeId,
		options.documentsBucket,
		snapshot,
	);
	// OMH logical file names are immutable, including after deletion. Repairing an
	// artifact therefore stores a new version under a name of its own.
	const r2Key = newFinalArtifactKey(finalDocument.envelopeId, artifact.sha256);
	await registerFinalArtifact(
		finalDocument.envelopeId,
		r2Key,
		snapshot,
		undefined,
		finalDocument.r2Key,
		options.access,
	);
	await options.documentsBucket.put(r2Key, artifact.bytes, {
		httpMetadata: { contentType: artifact.contentType },
	});
	if (finalDocument.id) {
		const updated = await db
			.update(finalDocuments)
			.set({
				r2Key,
				sha256: artifact.sha256,
				byteSize: artifact.byteSize,
				contentType: artifact.contentType,
			})
			.where(
				sql`${finalDocuments.id} = ${finalDocument.id} and ${finalDocuments.r2Key} = ${finalDocument.r2Key} and ${finalArtifactGuard(finalDocument.envelopeId, snapshot, undefined, options.access)} and exists (select 1 from envelopes e where e.id = ${finalDocument.envelopeId} and e.status = 'completed')`,
			)
			.returning();
		if (updated.length !== 1) throw new Error("Document changed during final PDF repair");
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
	snapshot: SigningFinalizationSnapshot,
): Promise<FinalDocumentArtifact> {
	const sourceDocument = snapshot.sourceDocument;
	if (!sourceDocument) throw new Error("Envelope source PDF required");
	const rows = snapshot.rows;
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
	const [envelope] = await db
		.select()
		.from(envelopes)
		.where(sql`${envelopes.id} = ${envelopeId} and ${noEnvelopeDeletion(envelopeId)}`)
		.limit(1);
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
	const [envelope] = await db
		.select()
		.from(envelopes)
		.where(sql`${envelopes.id} = ${envelopeId} and ${noEnvelopeDeletion(envelopeId)}`)
		.limit(1);
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
