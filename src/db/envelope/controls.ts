import { eq } from "drizzle-orm";
import { getDb } from "@/db/setup";
import { getArtifactVersionKeys } from "./artifact-versions";
import {
	EnvelopeSchema,
	type EnvelopeStatus,
	FinalDocumentSchema,
	getEnvelopeAllowedActions,
	RecipientSchema,
	SignerTokenSchema,
	SourceDocumentSchema,
} from "./schema";
import {
	auditEvents,
	emailSendRecords,
	envelopeRecipients,
	envelopes,
	finalDocuments,
	signerTokens,
	sourceDocuments,
} from "./table";

export type EnvelopeControlAction = "cancel" | "expire" | "delete";

export interface EnvelopeControlResult {
	envelopeId: string;
	action: EnvelopeControlAction;
	status: EnvelopeStatus;
	allowedActions: string[];
}

export interface EnvelopeRetentionStatus {
	envelopeId: string;
	status: EnvelopeStatus;
	retentionEligibleAt: string | null;
	retentionEligible: boolean;
}

export class EnvelopeControlError extends Error {
	constructor(
		public readonly code: "ENVELOPE_ACTION_BLOCKED",
		public readonly status: EnvelopeStatus,
		public readonly allowedActions: string[],
	) {
		super("Envelope action is not allowed in the current state");
		this.name = "EnvelopeControlError";
	}
}

const activeControlStatuses = new Set<EnvelopeStatus>(["sent", "changes_requested"]);
const retentionWindowMs = 90 * 24 * 60 * 60 * 1000;

export async function controlEnvelope(
	envelopeId: string,
	actor: string,
	action: EnvelopeControlAction,
	options: { documentsBucket?: R2Bucket } = {},
): Promise<EnvelopeControlResult> {
	const envelope = await getRequiredEnvelope(envelopeId);
	if (action === "cancel" || action === "expire") {
		return expireActiveEnvelope({
			envelopeId,
			actor,
			currentStatus: envelope.status,
			action,
		});
	}
	return deleteEnvelope({
		envelopeId,
		actor,
		currentStatus: envelope.status,
		documentsBucket: options.documentsBucket,
	});
}

export async function getEnvelopeStatus(envelopeId: string): Promise<EnvelopeStatus | null> {
	const db = getDb();
	const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(1);
	return envelope ? EnvelopeSchema.parse(envelope).status : null;
}

export async function getEnvelopeCreatorEmail(envelopeId: string): Promise<string | null> {
	const db = getDb();
	const rows = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(10);
	const row = rows.find((candidate) => candidate.id === envelopeId) ?? rows[0];
	return row ? EnvelopeSchema.parse(row).createdBy : null;
}

export async function getEnvelopeRetentionStatus(
	envelopeId: string,
	now = new Date(),
): Promise<EnvelopeRetentionStatus> {
	const envelope = await getRequiredEnvelope(envelopeId);
	const terminalAt = await getTerminalTimestamp(envelopeId, envelope.status);
	const retentionEligibleAt = terminalAt
		? new Date(terminalAt.getTime() + retentionWindowMs)
		: null;
	return {
		envelopeId,
		status: envelope.status,
		retentionEligibleAt: retentionEligibleAt?.toISOString() ?? null,
		retentionEligible: retentionEligibleAt ? retentionEligibleAt <= now : false,
	};
}

async function expireActiveEnvelope(input: {
	envelopeId: string;
	actor: string;
	currentStatus: EnvelopeStatus;
	action: "cancel" | "expire";
}): Promise<EnvelopeControlResult> {
	if (!activeControlStatuses.has(input.currentStatus)) {
		throw new EnvelopeControlError(
			"ENVELOPE_ACTION_BLOCKED",
			input.currentStatus,
			getEnvelopeAllowedActions(input.currentStatus),
		);
	}

	const db = getDb();
	const eventType = input.action === "cancel" ? "envelope.canceled" : "envelope.expired";
	await db.update(envelopes).set({ status: "expired" }).where(eq(envelopes.id, input.envelopeId));
	await db
		.insert(auditEvents)
		.values({
			envelopeId: input.envelopeId,
			recipientId: null,
			eventType,
			message: input.actor,
		})
		.returning();
	await recordRecipientNotification({
		envelopeId: input.envelopeId,
		kind: input.action === "cancel" ? "cancel" : "expiration",
	});

	return {
		envelopeId: input.envelopeId,
		action: input.action,
		status: "expired",
		allowedActions: getEnvelopeAllowedActions("expired"),
	};
}

async function recordRecipientNotification(input: {
	envelopeId: string;
	kind: string;
}): Promise<void> {
	const db = getDb();
	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, input.envelopeId))
			.limit(100)
	).map((recipient) => RecipientSchema.parse(recipient));
	const tokens = (
		await db
			.select()
			.from(signerTokens)
			.where(eq(signerTokens.envelopeId, input.envelopeId))
			.limit(100)
	).map((token) => SignerTokenSchema.parse(token));
	const records = recipients.flatMap((recipient) => {
		const token = latestSignerToken(tokens, recipient.id);
		if (!token) return [];
		return [
			{
				envelopeId: input.envelopeId,
				recipientId: recipient.id,
				tokenId: token.id,
				email: recipient.email,
				kind: input.kind,
				fallbackUrl: `/signing/${token.token}`,
			},
		];
	});
	if (records.length > 0) await db.insert(emailSendRecords).values(records).returning();
}

async function deleteEnvelope(input: {
	envelopeId: string;
	actor: string;
	currentStatus: EnvelopeStatus;
	documentsBucket?: R2Bucket;
}): Promise<EnvelopeControlResult> {
	if (input.currentStatus === "deleted") {
		return {
			envelopeId: input.envelopeId,
			action: "delete",
			status: "deleted",
			allowedActions: getEnvelopeAllowedActions("deleted"),
		};
	}

	const db = getDb();
	const sources = (
		await db
			.select()
			.from(sourceDocuments)
			.where(eq(sourceDocuments.envelopeId, input.envelopeId))
			.limit(100)
	).map((document) => SourceDocumentSchema.parse(document));
	const finals = (
		await db
			.select()
			.from(finalDocuments)
			.where(eq(finalDocuments.envelopeId, input.envelopeId))
			.limit(100)
	).map((document) => FinalDocumentSchema.parse(document));
	const keys = [
		...new Set([
			...sources.map((document) => document.r2Key),
			...finals.map((document) => document.r2Key),
			...(await getArtifactVersionKeys(input.envelopeId)),
		]),
	];
	if (keys.length > 0) {
		if (!input.documentsBucket)
			throw new Error("Private document storage is required for deletion");
		await input.documentsBucket.delete(keys);
	}

	await db.update(envelopes).set({ status: "deleted" }).where(eq(envelopes.id, input.envelopeId));
	await db
		.insert(auditEvents)
		.values({
			envelopeId: input.envelopeId,
			recipientId: null,
			eventType: "envelope.deleted",
			message: input.actor,
		})
		.returning();
	await recordRecipientNotification({ envelopeId: input.envelopeId, kind: "delete" });

	return {
		envelopeId: input.envelopeId,
		action: "delete",
		status: "deleted",
		allowedActions: getEnvelopeAllowedActions("deleted"),
	};
}

async function getRequiredEnvelope(envelopeId: string): Promise<{
	id: string;
	status: EnvelopeStatus;
}> {
	const db = getDb();
	const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(1);
	if (!envelope) throw new Error("Envelope not found");
	const parsed = EnvelopeSchema.parse(envelope);
	return { id: parsed.id, status: parsed.status };
}

async function getTerminalTimestamp(
	envelopeId: string,
	status: EnvelopeStatus,
): Promise<Date | null> {
	const db = getDb();
	if (status === "completed") {
		const documents = (
			await db
				.select()
				.from(finalDocuments)
				.where(eq(finalDocuments.envelopeId, envelopeId))
				.limit(100)
		).map((document) => FinalDocumentSchema.parse(document));
		return (
			[...documents]
				.map((document) => document.createdAt)
				.filter((createdAt): createdAt is Date => createdAt instanceof Date)
				.sort((left, right) => left.getTime() - right.getTime())[0] ?? null
		);
	}
	if (status === "expired") {
		const events = await db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.envelopeId, envelopeId))
			.limit(100);
		return (
			events
				.filter((event) =>
					["envelope.expired", "envelope.canceled"].includes(String(event.eventType)),
				)
				.map((event) => event.createdAt)
				.filter((createdAt): createdAt is Date => createdAt instanceof Date)
				.sort((left, right) => left.getTime() - right.getTime())[0] ?? null
		);
	}
	return null;
}

function latestSignerToken(
	tokens: ReturnType<typeof SignerTokenSchema.parse>[],
	recipientId: string,
) {
	return [...tokens]
		.filter((token) => token.status === "active" && token.recipientId === recipientId)
		.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
}
