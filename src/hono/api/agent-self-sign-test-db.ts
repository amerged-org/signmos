import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { agenticApiTokens, agenticSecurityEvents } from "@/db/agentic-access/table";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	idempotencyRecords,
	rateLimitRecords,
	signatureProfiles,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope/table";

export type AgentSelfSignStoredRow = Record<string, unknown>;

type SelectQuery = Promise<AgentSelfSignStoredRow[]> & {
	where: (condition: unknown) => SelectQuery;
	limit: (count: number) => Promise<AgentSelfSignStoredRow[]>;
};

type MutationQuery = Promise<AgentSelfSignStoredRow[]> & {
	returning: () => Promise<AgentSelfSignStoredRow[]>;
};

export const agentSelfSignTestState = {
	rows: new Map<unknown, AgentSelfSignStoredRow[]>(),
	r2Objects: new Map<string, Uint8Array>(),
	r2PutCounts: new Map<string, number>(),
	r2DeleteCounts: new Map<string, number>(),
	now: new Date("2026-07-17T10:00:00.000Z"),
};

export const agentSelfSignTables = [
	agenticApiTokens,
	agenticSecurityEvents,
	envelopes,
	idempotencyRecords,
	rateLimitRecords,
	sourceDocuments,
	envelopeRecipients,
	signatureProfiles,
	signerTokens,
	emailSendRecords,
	envelopeFields,
	fieldValues,
	auditEvents,
	finalDocuments,
] as const;

export async function contractPdfFixture(): Promise<ArrayBuffer> {
	const pdf = await PDFDocument.create();
	pdf.setCreationDate(new Date("2026-10-21T08:00:00Z"));
	pdf.setModificationDate(new Date("2026-10-21T08:00:00Z"));
	pdf.addPage([612, 792]).drawText("Contract fixture");
	return Uint8Array.from(await pdf.save({ useObjectStreams: false })).buffer;
}

export function selfSignRows(table: unknown): AgentSelfSignStoredRow[] {
	const tableRows = agentSelfSignTestState.rows.get(table) ?? [];
	agentSelfSignTestState.rows.set(table, tableRows);
	return tableRows;
}

function conditionValues(condition: unknown): unknown[] {
	if (!condition || typeof condition !== "object") return [];
	if ("value" in condition && isConditionValue(condition.value)) return [condition.value];
	if (!("queryChunks" in condition) || !Array.isArray(condition.queryChunks)) return [];
	return condition.queryChunks.flatMap(conditionValues);
}

function isConditionValue(value: unknown): boolean {
	return typeof value === "string" || typeof value === "number" || value instanceof Date;
}

function matches(row: AgentSelfSignStoredRow, condition: unknown): boolean {
	const values = conditionValues(condition);
	return values.every((value) =>
		Object.values(row).some((candidate) => equalValue(candidate, value)),
	);
}

function equalValue(left: unknown, right: unknown): boolean {
	if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
	return left === right;
}

function selectQuery(table: unknown, selected = selfSignRows(table)): SelectQuery {
	return Object.assign(Promise.resolve(selected), {
		where: (condition: unknown) =>
			selectQuery(
				table,
				selected.filter((row) => matches(row, condition)),
			),
		limit: async (count: number) => selected.slice(0, count),
	});
}

function mutationQuery(rows: AgentSelfSignStoredRow[]): MutationQuery {
	return Object.assign(Promise.resolve(rows), { returning: async () => rows });
}

function insertedRows(table: unknown, input: AgentSelfSignStoredRow[]): AgentSelfSignStoredRow[] {
	const target = selfSignRows(table);
	const inserted = input.map((row, index) => ({
		id: row.id ?? nextId(target.length + index + 1),
		...tableDefaults(table),
		...row,
	}));
	target.push(...inserted);
	return inserted;
}

function tableDefaults(table: unknown): AgentSelfSignStoredRow {
	const now = agentSelfSignTestState.now;
	if (table === envelopes) {
		return { status: "draft", signingMode: "only_me", createdAt: now, sentBy: null, sentAt: null };
	}
	if (table === sourceDocuments) return { version: 1, uploadedAt: now };
	if (table === envelopeRecipients) return { status: "pending", createdAt: now };
	if (table === signatureProfiles) return { selected: true, createdAt: now };
	if (table === signerTokens) return { status: "active", createdAt: now };
	if (table === emailSendRecords) return { sentAt: now };
	if (table === envelopeFields) return { createdAt: now };
	if (table === fieldValues) return { completedAt: now };
	if (table === finalDocuments) return { createdAt: now };
	return { createdAt: now };
}

function nextId(sequence: number): string {
	return `80000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

export const getAgentSelfSignTestDb = () => ({
	select: () => ({ from: (table: unknown) => selectQuery(table) }),
	insert: (table: unknown) => ({
		values: (value: AgentSelfSignStoredRow | AgentSelfSignStoredRow[]) => ({
			returning: async () => insertedRows(table, Array.isArray(value) ? value : [value]),
		}),
	}),
	update: (table: unknown) => ({
		set: (values: AgentSelfSignStoredRow) => ({
			where: (condition: unknown) => {
				const updated = selfSignRows(table).filter((row) => matches(row, condition));
				for (const row of updated) Object.assign(row, values);
				return mutationQuery(updated);
			},
		}),
	}),
	delete: (table: unknown) => ({
		where: (condition: unknown) => {
			const target = selfSignRows(table);
			const deleted = target.filter((row) => matches(row, condition));
			agentSelfSignTestState.rows.set(
				table,
				target.filter((row) => !deleted.includes(row)),
			);
			return mutationQuery(deleted);
		},
	}),
});

export function agentSelfSignBucket(): R2Bucket {
	return {
		put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
			const bytes =
				value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
			agentSelfSignTestState.r2Objects.set(key, new Uint8Array(bytes));
			agentSelfSignTestState.r2PutCounts.set(
				key,
				(agentSelfSignTestState.r2PutCounts.get(key) ?? 0) + 1,
			);
			return null;
		},
		get: async (key: string) => {
			const bytes = agentSelfSignTestState.r2Objects.get(key);
			return bytes ? ({ arrayBuffer: async () => bytes.buffer } as R2ObjectBody) : null;
		},
		delete: async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				agentSelfSignTestState.r2Objects.delete(key);
				agentSelfSignTestState.r2DeleteCounts.set(
					key,
					(agentSelfSignTestState.r2DeleteCounts.get(key) ?? 0) + 1,
				);
			}
		},
	} as R2Bucket;
}

export function extractPdfVisibleText(bytes: Uint8Array): string {
	const serialized = Buffer.from(bytes).toString("latin1");
	const streams = [...serialized.matchAll(/stream\n([\s\S]*?)\nendstream/g)].flatMap((match) => {
		try {
			return [inflateSync(Buffer.from(match[1] ?? "", "latin1")).toString("latin1")];
		} catch {
			return [];
		}
	});
	return streams
		.flatMap((stream) =>
			[...stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((match) =>
				Buffer.from(match[1] ?? "", "hex").toString("utf8"),
			),
		)
		.join("\n");
}
