import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/setup";
import type { VerifiedAgenticManagementSession } from "./credential-authority";
import { appendAgenticSecurityEvent } from "./security-audit";
import { agenticApiTokens } from "./table";
import { agenticActiveTokenLimit } from "./token-authority";

export interface AgenticTokenMetadata {
	id: string;
	name: string;
	hint: string;
	createdAt: string;
	lastUsedAt: string | null;
	status: "active" | "revoked";
	revokedAt: string | null;
}

export async function listAgenticTokens(email: string): Promise<{
	activeLimit: number;
	tokens: AgenticTokenMetadata[];
}> {
	const rows = await getDb()
		.select()
		.from(agenticApiTokens)
		.where(eq(agenticApiTokens.email, email));
	return {
		activeLimit: agenticActiveTokenLimit,
		tokens: rows
			.filter(
				(token) =>
					token.email === email && (token.status === "active" || token.status === "revoked"),
			)
			.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
			.map(toAgenticTokenMetadata),
	};
}

export type RevokeAgenticTokenResult =
	| { state: "revoked"; token: AgenticTokenMetadata }
	| { state: "not_found" | "already_revoked" };

export async function revokeAgenticToken(input: {
	session: VerifiedAgenticManagementSession;
	tokenId: string;
	now?: Date;
	requestIp?: string;
}): Promise<RevokeAgenticTokenResult> {
	const db = getDb();
	const rows = await db
		.select()
		.from(agenticApiTokens)
		.where(
			and(eq(agenticApiTokens.id, input.tokenId), eq(agenticApiTokens.email, input.session.email)),
		)
		.limit(1);
	const token = rows.find(
		(candidate) => candidate.id === input.tokenId && candidate.email === input.session.email,
	);
	if (!token) return { state: "not_found" };
	if (token.status !== "active") return { state: "already_revoked" };

	const now = input.now ?? new Date();
	const updated = await db
		.update(agenticApiTokens)
		.set({ status: "revoked", activeSlot: null, revokedAt: now })
		.where(and(eq(agenticApiTokens.id, token.id), eq(agenticApiTokens.status, "active")))
		.returning();
	const revoked = updated.find((candidate) => candidate.id === token.id);
	if (!revoked) return { state: "already_revoked" };
	await appendAgenticSecurityEvent({
		sessionId: input.session.id,
		tokenId: revoked.id,
		tokenName: revoked.name,
		email: revoked.email,
		eventType: "agentic.token.revoked",
		actorType: "browser",
		requestIp: input.requestIp,
	});
	return { state: "revoked", token: toAgenticTokenMetadata(revoked) };
}

function toAgenticTokenMetadata(token: typeof agenticApiTokens.$inferSelect): AgenticTokenMetadata {
	return {
		id: token.id,
		name: token.name,
		hint: token.tokenHint,
		createdAt: token.createdAt.toISOString(),
		lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
		status: token.status === "revoked" ? "revoked" : "active",
		revokedAt: token.revokedAt?.toISOString() ?? null,
	};
}
