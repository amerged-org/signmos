import { and, eq } from "drizzle-orm";
import { isUniqueViolation } from "@/core/errors";
import { getDb } from "@/db/setup";
import type { AgenticPrincipal } from "./bearer-principal";
import { agenticCommandRecords } from "./table";

export type AgentCommandClaim =
	| { state: "execute"; recordId: string }
	| { state: "replay"; status: number; body: unknown }
	| { state: "conflict" }
	| { state: "in_progress" };

export async function claimAgentCommand(input: {
	principal: AgenticPrincipal;
	idempotencyKey: string;
	operation: string;
	requestFingerprint: string;
}): Promise<AgentCommandClaim> {
	const existing = await findCommand(input.principal.token.id, input.idempotencyKey);
	if (existing) return existingClaim(existing, input);
	try {
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
			.returning();
		if (!record) throw new Error("Failed to claim Agent API command");
		return { state: "execute", recordId: record.id };
	} catch (error) {
		if (!isUniqueViolation(error)) throw error;
		const concurrent = await findCommand(input.principal.token.id, input.idempotencyKey);
		if (!concurrent) throw error;
		return existingClaim(concurrent, input);
	}
}

export async function completeAgentCommand(input: {
	recordId: string;
	status: number;
	body: unknown;
	documentId?: string | null;
	now?: Date;
}): Promise<void> {
	await getDb()
		.update(agenticCommandRecords)
		.set({
			state: "completed",
			responseStatus: input.status,
			responseBody: JSON.stringify(input.body),
			documentId: input.documentId ?? null,
			completedAt: input.now ?? new Date(),
		})
		.where(eq(agenticCommandRecords.id, input.recordId));
}

export async function fingerprintAgentCommand(value: unknown): Promise<string> {
	return sha256Hex(new TextEncoder().encode(stableJson(value)));
}

export async function fingerprintAgentBinaryCommand(input: {
	bytes: Uint8Array;
	contentType: string;
	filename: string;
}): Promise<string> {
	return fingerprintAgentCommand({
		contentType: input.contentType,
		filename: input.filename,
		sha256: await sha256Hex(input.bytes),
	});
}

interface StoredCommand {
	id: string;
	operation: string;
	requestFingerprint: string;
	state: string;
	responseStatus: number | null;
	responseBody: string | null;
}

async function findCommand(tokenId: string, idempotencyKey: string): Promise<StoredCommand | null> {
	const rows = await getDb()
		.select()
		.from(agenticCommandRecords)
		.where(
			and(
				eq(agenticCommandRecords.tokenId, tokenId),
				eq(agenticCommandRecords.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	const row = rows.find(
		(candidate) => candidate.tokenId === tokenId && candidate.idempotencyKey === idempotencyKey,
	);
	return row
		? {
				id: row.id,
				operation: row.operation,
				requestFingerprint: row.requestFingerprint,
				state: row.state,
				responseStatus: row.responseStatus,
				responseBody: row.responseBody,
			}
		: null;
}

function existingClaim(
	record: StoredCommand,
	input: { operation: string; requestFingerprint: string },
): AgentCommandClaim {
	if (
		record.operation !== input.operation ||
		record.requestFingerprint !== input.requestFingerprint
	) {
		return { state: "conflict" };
	}
	if (
		record.state === "completed" &&
		typeof record.responseStatus === "number" &&
		record.responseBody !== null
	) {
		return {
			state: "replay",
			status: record.responseStatus,
			body: JSON.parse(record.responseBody) as unknown,
		};
	}
	return { state: "in_progress" };
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	// Code-unit order: localeCompare initializes ICU, which costs 10-40 ms of a Worker's 50 ms
	// CPU on a cold isolate, and the canonical form must not depend on a locale anyway.
	const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
