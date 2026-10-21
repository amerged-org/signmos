import { eq } from "drizzle-orm";
import {
	type EnvelopeField,
	EnvelopeFieldSchema,
	EnvelopeSchema,
	type EnvelopeStatus,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	RecipientSchema,
	type SignerToken,
	SignerTokenSchema,
	signerTokens,
} from "@/db/envelope";
import { getDb } from "@/db/setup";
import type { AgenticPrincipal } from "./bearer-principal";

export type AgentPartnerSigningAuthorization =
	| { state: "active"; token: SignerToken }
	| { state: "not_found" }
	| { state: "wrong_identity" }
	| { state: "inactive"; status: EnvelopeStatus }
	| { state: "completed" }
	| { state: "changes_requested" }
	| { state: "declined" }
	| { state: "expired" }
	| { state: "deleted" };

export async function authorizeAgentPartnerSigning(
	principal: AgenticPrincipal,
	documentId: string,
	options: { allowCompletionRetry?: boolean } = {},
): Promise<AgentPartnerSigningAuthorization> {
	const db = getDb();
	const [envelopeRows, recipientRows, tokenRows] = await Promise.all([
		db.select().from(envelopes).where(eq(envelopes.id, documentId)).limit(1),
		db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, documentId))
			.limit(10),
		db.select().from(signerTokens).where(eq(signerTokens.envelopeId, documentId)).limit(100),
	]);
	const envelopeRow = envelopeRows.find((candidate) => candidate.id === documentId);
	if (!envelopeRow) return { state: "not_found" };
	const envelope = EnvelopeSchema.parse(envelopeRow);
	if (envelope.signingMode === "only_me") return { state: "not_found" };
	const email = normalizeEmail(principal.email);
	if (normalizeEmail(envelope.createdBy) === email) return { state: "wrong_identity" };
	const recipientRow = recipientRows.find(
		(candidate) => candidate.envelopeId === documentId && normalizeEmail(candidate.email) === email,
	);
	if (!recipientRow) return { state: "wrong_identity" };
	const recipient = RecipientSchema.parse(recipientRow);
	if (envelope.status === "deleted") return { state: "deleted" };
	if (envelope.status === "expired") return { state: "expired" };
	if (envelope.status === "declined" || recipient.status === "declined") {
		return { state: "declined" };
	}
	if (envelope.status === "changes_requested") return { state: "changes_requested" };
	const isFinalizationRetry = canRetryFinalization(
		options.allowCompletionRetry,
		envelope.status,
		recipient.status,
		recipientRows.filter((candidate) => candidate.envelopeId === documentId),
	);
	if (signingIsCompleted(envelope.status, recipient.status, isFinalizationRetry)) {
		return { state: "completed" };
	}
	if (envelope.status !== "sent") return { state: "inactive", status: envelope.status };
	if (!["pending", "sent"].includes(recipient.status) && !isFinalizationRetry) {
		return { state: "inactive", status: envelope.status };
	}
	const tokenRow = tokenRows
		.filter(
			(candidate) =>
				candidate.envelopeId === documentId &&
				candidate.recipientId === recipient.id &&
				candidate.status === "active",
		)
		.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
	return tokenRow
		? { state: "active", token: SignerTokenSchema.parse(tokenRow) }
		: { state: "inactive", status: envelope.status };
}

function signingIsCompleted(
	envelopeStatus: string,
	recipientStatus: string,
	isFinalizationRetry: boolean,
): boolean {
	return (
		envelopeStatus === "completed" || (recipientStatus === "completed" && !isFinalizationRetry)
	);
}

function canRetryFinalization(
	allowed: boolean | undefined,
	envelopeStatus: string,
	recipientStatus: string,
	recipients: Array<typeof envelopeRecipients.$inferSelect>,
): boolean {
	return (
		allowed === true &&
		envelopeStatus === "sent" &&
		recipientStatus === "completed" &&
		recipients.every((recipient) => recipient.status === "completed")
	);
}

export async function listAgentPartnerFields(token: SignerToken): Promise<EnvelopeField[]> {
	const rows = await getDb()
		.select()
		.from(envelopeFields)
		.where(eq(envelopeFields.recipientId, token.recipientId))
		.limit(100);
	return rows
		.map((row) => EnvelopeFieldSchema.parse(row))
		.filter(
			(field) => field.envelopeId === token.envelopeId && field.recipientId === token.recipientId,
		);
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}
