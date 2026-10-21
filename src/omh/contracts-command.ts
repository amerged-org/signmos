import { eq } from "drizzle-orm";
import {
	type AgenticPrincipal,
	claimAgentCommand,
	fingerprintAgentCommand,
} from "@/db/agentic-access";
import { agenticApiTokens, agenticCommandRecords } from "@/db/agentic-access/table";
import { getDb } from "@/db/setup";

/** A non-authenticating owner row provides durable idempotency for browser commands. */
export async function contractCommandPrincipal(input: {
	email: string;
	agent?: AgenticPrincipal;
}): Promise<AgenticPrincipal> {
	if (input.agent) return input.agent;
	const email = input.email.trim().toLowerCase();
	const tokenHash = await fingerprintAgentCommand({ kind: "contracts-internal", email });
	const db = getDb();
	await db
		.insert(agenticApiTokens)
		.values({
			email,
			name: "Contracts browser commands",
			tokenHash,
			tokenHint: "internal",
			status: "internal",
			activeSlot: null,
		})
		.onConflictDoNothing({ target: agenticApiTokens.tokenHash });
	const [token] = await db
		.select()
		.from(agenticApiTokens)
		.where(eq(agenticApiTokens.tokenHash, tokenHash))
		.limit(1);
	if (!token || token.status !== "internal" || token.email !== email)
		throw new Error("Browser command identity unavailable");
	return {
		email,
		actorType: "agent",
		token: {
			id: token.id,
			name: token.name,
			hint: token.tokenHint,
			createdAt: token.createdAt,
			lastUsedAt: new Date(),
		},
	};
}

/** Fresh commands claim in one RPC; existing receipts retain the shared replay/conflict contract. */
export async function claimContractCommand(
	input: Parameters<typeof claimAgentCommand>[0],
): ReturnType<typeof claimAgentCommand> {
	const [record] = await getDb()
		.insert(agenticCommandRecords)
		.values({
			tokenId: input.principal.token.id,
			idempotencyKey: input.idempotencyKey,
			operation: input.operation,
			requestFingerprint: input.requestFingerprint,
			state: "pending",
			responseStatus: null,
			responseBody: null,
			documentId: null,
			completedAt: null,
		})
		.onConflictDoNothing({
			target: [agenticCommandRecords.tokenId, agenticCommandRecords.idempotencyKey],
		})
		.returning();
	return record ? { state: "execute", recordId: record.id } : claimAgentCommand(input);
}
