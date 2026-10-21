import { getTableColumns, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agenticApiTokens, agenticCommandRecords } from "@/db/agentic-access/table";
import { envelopeRecipients, envelopes, sourceDocuments } from "@/db/envelope/table";

type Row = Record<string, unknown>;
const dialect = new PgDialect();
export const contractsTestState = {
	rows: new Map<unknown, Row[]>(),
	objects: new Map<string, Uint8Array>(),
	now: new Date("2026-10-21T10:00:00.000Z"),
};
export function contractRows(table: unknown): Row[] {
	const rows = contractsTestState.rows.get(table) ?? [];
	contractsTestState.rows.set(table, rows);
	return rows;
}

function matches(table: Table, row: Row, condition: SQL): boolean {
	const query = dialect.sqlToQuery(condition);
	const columns = getTableColumns(table);
	const property = (name: string): string =>
		Object.entries(columns).find(([, column]) => column.name === name)?.[0] ?? name;
	for (const match of query.sql.matchAll(/"[^"]+"\."([^"]+)" = \$(\d+)/g)) {
		if (row[property(match[1] ?? "")] !== query.params[Number(match[2]) - 1]) return false;
	}
	for (const match of query.sql.matchAll(/"[^"]+"\."([^"]+)" in \(([^)]+)\)/g)) {
		const values = [...(match[2] ?? "").matchAll(/\$(\d+)/g)].map(
			(value) => query.params[Number(value[1]) - 1],
		);
		if (!values.includes(row[property(match[1] ?? "")])) return false;
	}
	return true;
}

function selectQuery(table: Table, selected = contractRows(table)): unknown {
	return Object.assign(Promise.resolve(selected), {
		where: (condition: SQL) =>
			selectQuery(
				table,
				selected.filter((row) => matches(table, row, condition)),
			),
		orderBy: () => selectQuery(table, [...selected].reverse()),
		limit: async (limit: number) => selected.slice(0, limit),
	});
}

function defaults(table: unknown): Row {
	const createdAt = contractsTestState.now;
	if (table === envelopes)
		return {
			createdAt,
			status: "draft",
			signingMode: "me_and_another_signer",
			createdByName: null,
			sentBy: null,
			sentAt: null,
		};
	if (table === sourceDocuments) return { createdAt, version: 1, uploadedAt: createdAt };
	if (table === envelopeRecipients) return { createdAt, status: "pending" };
	return { createdAt };
}

function mutation(execute: (ignoreConflicts: boolean) => Row[]) {
	let ignoreConflicts = false;
	let result: Row[] | undefined;
	const run = (): Row[] => {
		result ??= execute(ignoreConflicts);
		return result;
	};
	const query = {
		// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders execute when awaited.
		then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve().then(run).then(resolve, reject),
		returning: async () => run(),
		onConflictDoNothing: (_options: unknown) => {
			ignoreConflicts = true;
			return query;
		},
	};
	return query;
}

function hasDuplicate(table: unknown, row: Row): boolean {
	const target = contractRows(table);
	if (table === agenticApiTokens)
		return target.some((existing) => existing.tokenHash === row.tokenHash);
	if (table === agenticCommandRecords)
		return target.some(
			(existing) =>
				existing.tokenId === row.tokenId && existing.idempotencyKey === row.idempotencyKey,
		);
	return false;
}

function insertRows(table: unknown, input: Row[], ignoreConflicts: boolean): Row[] {
	const inserted: Row[] = [];
	for (const row of input) {
		if (hasDuplicate(table, row)) {
			if (ignoreConflicts) continue;
			throw { cause: { code: "23505" } };
		}
		const created = { id: crypto.randomUUID(), ...defaults(table), ...row };
		contractRows(table).push(created);
		inserted.push(created);
	}
	return inserted;
}

export function getContractsTestDb() {
	return {
		select: () => ({ from: (table: Table) => selectQuery(table) }),
		insert: (table: unknown) => ({
			values: (value: Row | Row[]) =>
				mutation((ignoreConflicts) =>
					insertRows(table, Array.isArray(value) ? value : [value], ignoreConflicts),
				),
		}),
		update: (table: Table) => ({
			set: (values: Row) => ({
				where: (condition: SQL) =>
					mutation(() => {
						const selected = contractRows(table).filter((row) => matches(table, row, condition));
						for (const row of selected) Object.assign(row, values);
						return selected;
					}),
			}),
		}),
	};
}

export function contractsTestBucket(): R2Bucket {
	return {
		put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
			const bytes =
				value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			contractsTestState.objects.set(key, Uint8Array.from(bytes));
			return null;
		},
		get: async (key: string) => {
			const bytes = contractsTestState.objects.get(key);
			return bytes ? { arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
		},
	} as R2Bucket;
}
