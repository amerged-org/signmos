import { eq, getTableColumns, sql } from "drizzle-orm";
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
	decodeSigningRow,
	isSigningGuardFailure,
	noEnvelopeDeletion,
	signingBatch,
	signingStatement,
} from "./signing-batch";
import { SigningCompletionBlockedError, type SigningCompletionContext } from "./signing-completion";
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
// Explicit outer identifiers survive Drizzle's single-table selection qualifier removal.
const tokenEnvelopeReference = sql`${sql.identifier("signer_tokens")}.${sql.identifier("envelope_id")}`;
const tokenRecipientReference = sql`${sql.identifier("signer_tokens")}.${sql.identifier("recipient_id")}`;

export type ResolvedSignerToken = SignerToken & {
	envelopeStatus: Envelope["status"];
	deletionPending: boolean;
	completionContext?: SigningCompletionContext;
};

export async function resolveSignerToken(
	token: string,
	options: { completion?: boolean } = {},
): Promise<ResolvedSignerToken | null> {
	const db = getDb();
	const tokens = await db
		.select({
			...getTableColumns(signerTokens),
			deletionPending: sql<boolean>`not (${noEnvelopeDeletion(tokenEnvelopeReference)})`,
			envelopeStatus: sql<string>`(select status from envelopes where id = ${tokenEnvelopeReference})`,
			completionContext: options.completion
				? sql<Record<string, unknown>>`jsonb_build_object(
			'envelope', (select to_jsonb(e) from envelopes e where e.id = ${tokenEnvelopeReference}),
			'fields', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from envelope_fields where envelope_id = ${tokenEnvelopeReference} limit 100) f), '[]'::jsonb),
			'recipients', coalesce((select jsonb_agg(to_jsonb(r)) from (select * from envelope_recipients where envelope_id = ${tokenEnvelopeReference} limit 10) r), '[]'::jsonb),
			'saved', coalesce((select jsonb_agg(to_jsonb(v)) from (select * from field_values where envelope_id = ${tokenEnvelopeReference} and recipient_id = ${tokenRecipientReference} limit 100) v), '[]'::jsonb))`
				: sql<null>`null`,
		})
		.from(signerTokens)
		.where(eq(signerTokens.token, token))
		.limit(1);
	const found = tokens.find((candidate) => candidate.token === token);
	if (!found) return null;
	const parsed = SignerTokenSchema.parse(found);
	if (parsed.status !== "active") return null;
	const completion = found.completionContext;
	return {
		...parsed,
		envelopeStatus: EnvelopeSchema.shape.status.parse(found.envelopeStatus),
		deletionPending: found.deletionPending,
		...(options.completion && completion
			? {
					completionContext: {
						envelope: EnvelopeSchema.parse(
							decodeSigningRow(envelopes, completion.envelope as Record<string, unknown>),
						),
						fields: (completion.fields as Array<Record<string, unknown>>).map((row) =>
							EnvelopeFieldSchema.parse(decodeSigningRow(envelopeFields, row)),
						),
						recipients: (completion.recipients as Array<Record<string, unknown>>).map((row) =>
							RecipientSchema.parse(decodeSigningRow(envelopeRecipients, row)),
						),
						saved: (completion.saved as Array<Record<string, unknown>>).map((row) =>
							decodeSigningRow(fieldValues, row),
						),
					},
				}
			: {}),
	};
}

export async function getSignerSession(
	token: SignerToken,
	options: { sourceDownloadUrl?: string } = {},
): Promise<SignerSession> {
	const db = getDb();
	const [envelopeRows = [], fieldRows = [], recipientRows = [], values = [], sources = []] =
		await signingBatch([
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
					.where(eq(fieldValues.envelopeId, token.envelopeId))
					.limit(100),
			},
			{
				table: sourceDocuments,
				query: db
					.select()
					.from(sourceDocuments)
					.where(eq(sourceDocuments.envelopeId, token.envelopeId))
					.limit(100),
			},
		]);
	const parsedEnvelope = EnvelopeSchema.parse(envelopeRows[0]);
	const allFields = fieldRows.map((field) => EnvelopeFieldSchema.parse(field));
	const fields = allFields.filter((field) => field.recipientId === token.recipientId);
	const recipients = recipientRows.map((recipient) => RecipientSchema.parse(recipient));
	const fieldValueRows = values.map((value) => FieldValueSchema.parse(value));
	const sourceDocument = latestSourceDocument(
		sources.map((document) => SourceDocumentSchema.parse(document)),
	);
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
	options: { now?: Date } = {},
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
	try {
		await signingBatch([
			signingStatement(sql`select id from envelopes where id = ${token.envelopeId} for update`),
			signingStatement(sql`/* signing-record-guard */ with locked as (
				select e.status as envelope_status, r.status as recipient_status, t.status as token_status, t.verified_at, t.expires_at
				from envelopes e join envelope_recipients r on r.envelope_id = e.id
				join signer_tokens t on t.envelope_id = e.id and t.recipient_id = r.id
				where e.id = ${token.envelopeId} and r.id = ${token.recipientId} and t.id = ${token.id} and t.token = ${token.token} for update of e, r, t
			) select 1 / case when exists(select 1 from locked where envelope_status = 'sent' and recipient_status = 'sent' and token_status = 'active' and verified_at is not null and expires_at > ${options.now ?? new Date()} and ${noEnvelopeDeletion(token.envelopeId)}) then 1 else 0 end as allowed`),
			db.insert(auditEvents).values(events),
			db
				.update(envelopeRecipients)
				.set({ status: "declined" })
				.where(eq(envelopeRecipients.id, token.recipientId)),
			db.update(envelopes).set({ status: "declined" }).where(eq(envelopes.id, token.envelopeId)),
		]);
	} catch (error) {
		if (isSigningGuardFailure(error)) throw new SigningCompletionBlockedError("sent");
		throw error;
	}

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
