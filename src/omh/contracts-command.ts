import { eq } from "drizzle-orm";
import { type AgenticPrincipal, fingerprintAgentCommand } from "@/db/agentic-access";
import { agenticApiTokens } from "@/db/agentic-access/table";
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
