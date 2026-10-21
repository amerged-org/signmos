import { and, eq } from "drizzle-orm";
import { isUniqueViolation } from "@/core/errors";
import { getDb } from "@/db/setup";
import { hashAgenticCredential } from "./request";
import { appendAgenticSecurityEvent } from "./security-audit";
import { agenticApiTokens } from "./table";

const tokenSecretBytes = 32;
export const agenticActiveTokenLimit = 5;

export class AgenticTokenLimitError extends Error {
	readonly limit = agenticActiveTokenLimit;

	constructor() {
		super("Five active Agentic tokens are already in use");
		this.name = "AgenticTokenLimitError";
	}
}

export interface GeneratedAgenticToken {
	secret: string;
	token: {
		id: string;
		name: string;
		hint: string;
		createdAt: string;
	};
}

export async function generateAgenticToken(input: {
	session: { id: string; email: string };
	name: string;
	requestIp?: string;
	/** Bound HTTP contention retries without changing the five active-token slots. */
	maximumAttempts?: number;
}): Promise<GeneratedAgenticToken> {
	const name = input.name.trim();
	const generated = await insertIntoAvailableSlot({
		email: input.session.email,
		name,
		maximumAttempts: input.maximumAttempts,
	});
	const { secret, token } = generated;
	await appendAgenticSecurityEvent({
		sessionId: input.session.id,
		tokenId: token.id,
		tokenName: token.name,
		email: token.email,
		eventType: "agentic.token.created",
		actorType: "browser",
		requestIp: input.requestIp,
	});
	return {
		secret,
		token: {
			id: token.id,
			name: token.name,
			hint: token.tokenHint,
			createdAt: token.createdAt.toISOString(),
		},
	};
}

async function insertIntoAvailableSlot(input: {
	email: string;
	name: string;
	maximumAttempts?: number;
}) {
	const db = getDb();
	for (
		let attempt = 0;
		attempt < Math.min(agenticActiveTokenLimit, input.maximumAttempts ?? agenticActiveTokenLimit);
		attempt += 1
	) {
		const rows = await db
			.select()
			.from(agenticApiTokens)
			.where(and(eq(agenticApiTokens.email, input.email), eq(agenticApiTokens.status, "active")))
			.limit(agenticActiveTokenLimit);
		const activeTokens = rows.filter(
			(token) => token.email === input.email && token.status === "active",
		);
		if (activeTokens.length >= agenticActiveTokenLimit) throw new AgenticTokenLimitError();
		const usedSlots = new Set(activeTokens.map((token) => token.activeSlot));
		const activeSlot = Array.from(
			{ length: agenticActiveTokenLimit },
			(_, index) => index + 1,
		).find((slot) => !usedSlots.has(slot));
		if (!activeSlot) throw new AgenticTokenLimitError();

		const secretBytes = new Uint8Array(tokenSecretBytes);
		crypto.getRandomValues(secretBytes);
		const secretSuffix = toBase64Url(secretBytes);
		const secret = `signmos_${secretSuffix}`;
		try {
			const inserted = await db
				.insert(agenticApiTokens)
				.values({
					email: input.email,
					name: input.name,
					tokenHash: await hashAgenticCredential(secret),
					tokenHint: `signmos_…${secretSuffix.slice(-4)}`,
					status: "active",
					activeSlot,
				})
				.returning();
			const token = inserted[0];
			if (!token) throw new Error("Agentic token was not created");
			return { secret, token };
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
		}
	}
	throw new AgenticTokenLimitError();
}

function toBase64Url(bytes: Uint8Array): string {
	const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
