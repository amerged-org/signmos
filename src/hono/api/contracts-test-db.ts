import { getTableColumns, getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agenticApiTokens, agenticCommandRecords } from "@/db/agentic-access/table";
import {
	auditEvents,
	envelopeRecipients,
	envelopes,
	finalDocuments,
	sourceDocuments,
} from "@/db/envelope/table";

type Row = Record<string, unknown>;
const dialect = new PgDialect();
const executeBatchQuery = Symbol("executeBatchQuery");
export const contractsTestState = {
	rows: new Map<unknown, Row[]>(),
	objects: new Map<string, Uint8Array>(),
	now: new Date("2026-10-21T10:00:00.000Z"),
	queryCalls: 0,
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
	for (const match of query.sql.matchAll(/"([^"]+)"\."([^"]+)" = \$(\d+)/g)) {
		if (
			match[1] === getTableName(table) &&
			row[property(match[2] ?? "")] !== query.params[Number(match[3]) - 1]
		)
			return false;
	}
	for (const match of query.sql.matchAll(/"[^"]+"\."([^"]+)" in \(([^)]+)\)/g)) {
		const values = [...(match[2] ?? "").matchAll(/\$(\d+)/g)].map(
			(value) => query.params[Number(value[1]) - 1],
		);
		if (!values.includes(row[property(match[1] ?? "")])) return false;
	}
	for (const match of query.sql.matchAll(/"[^"]+"\."([^"]+)" <> \$(\d+)/g)) {
		if (row[property(match[1] ?? "")] === query.params[Number(match[2]) - 1]) return false;
	}
	if (deletionExcluded(table, row, query.sql)) return false;
	return true;
}

function deletionExcluded(table: Table, row: Row, query: string): boolean {
	return (
		table === envelopes &&
		query.includes('"contract_deletion"') &&
		contractRows(auditEvents).some(
			(event) => event.envelopeId === row.id && event.eventType === "envelope.deletion_started",
		)
	);
}

function projectSelection(table: Table, row: Row, selection?: Record<string, unknown>): Row {
	if (table !== envelopes || !selection) return row;
	const recipients = contractRows(envelopeRecipients).filter((item) => item.envelopeId === row.id);
	const sources = contractRows(sourceDocuments)
		.filter((item) => item.envelopeId === row.id)
		.sort((a, b) => Number(b.version) - Number(a.version));
	const finals = contractRows(finalDocuments)
		.filter((item) => item.envelopeId === row.id)
		.sort(
			(a, b) => new Date(String(b.createdAt)).getTime() - new Date(String(a.createdAt)).getTime(),
		);
	const titles = contractRows(auditEvents).filter(
		(item) => item.envelopeId === row.id && item.eventType === "contract.created",
	);
	const deleting = contractRows(auditEvents).some(
		(event) => event.envelopeId === row.id && event.eventType === "envelope.deletion_started",
	);
	const derived: Row = {
		recipients: recipients.map((item) => ({
			name: item.name,
			email: item.email,
			status: item.status,
		})),
		sourceFilename: sources[0]?.originalFilename ?? null,
		finalCreatedAt:
			finals[0] && !deleting ? new Date(String(finals[0].createdAt)).toISOString() : null,
		title: titles.at(-1)?.message ?? null,
		r2Key: finals[0]?.r2Key ?? null,
	};
	return Object.fromEntries(
		Object.keys(selection).map((key) => [key, key in derived ? derived[key] : row[key]]),
	);
}

function selectQuery(
	table: Table,
	selected = contractRows(table),
	selection?: Record<string, unknown>,
): unknown {
	const run = (countRpc = true) => {
		if (countRpc) contractsTestState.queryCalls += 1;
		return selected.map((row) => projectSelection(table, row, selection));
	};
	return {
		[executeBatchQuery]: () => run(false),
		// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders execute when awaited.
		then: (resolve: (rows: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve()
				.then(() => run())
				.then(resolve, reject),
		where: (condition: SQL) =>
			selectQuery(
				table,
				selected.filter((row) => matches(table, row, condition)),
				selection,
			),
		orderBy: () => selectQuery(table, [...selected].reverse(), selection),
		limit: async (limit: number) => run().slice(0, limit),
	};
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
	const run = (countRpc = true): Row[] => {
		if (!result) {
			if (countRpc) contractsTestState.queryCalls += 1;
			result = execute(ignoreConflicts);
		}
		return result;
	};
	const query = {
		[executeBatchQuery]: () => run(false),
		// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders execute when awaited.
		then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve()
				.then(() => run())
				.then(resolve, reject),
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

function runBatchQuery(query: unknown): Row[] {
	if (!query || typeof query !== "object") throw new Error("Invalid batch query");
	if (executeBatchQuery in query && typeof query[executeBatchQuery] === "function")
		return query[executeBatchQuery]();
	if (!("toSQL" in query) || typeof query.toSQL !== "function")
		throw new Error("Batch query has no executor");
	const built = query.toSQL() as { sql: string; params: unknown[] };
	if (built.sql.startsWith('select "envelopes"."id"') && built.sql.includes("for update of"))
		return [];
	if (!built.sql.startsWith("select 1 / case when exists")) throw new Error("Unknown batch SQL");
	const parameter = (table: string, column: string): unknown => {
		const match = new RegExp(`"${table}"\\."${column}" = \\$(\\d+)`).exec(built.sql);
		return match ? built.params[Number(match[1]) - 1] : undefined;
	};
	const command = contractRows(agenticCommandRecords).find(
		(row) => row.id === parameter("agentic_command_records", "id"),
	);
	let valid = command?.state === "pending";
	if (built.sql.includes('"envelopes"')) {
		const envelope = contractRows(envelopes).find((row) => row.id === parameter("envelopes", "id"));
		valid =
			valid &&
			envelope?.status === "draft" &&
			envelope.createdBy === parameter("envelopes", "created_by") &&
			command?.documentId === envelope.id;
	} else valid = valid && command?.documentId === null;
	if (!valid) throw new Error("Contract lifecycle guard rejected");
	return [{ guard: 1 }];
}

export function getContractsTestDb() {
	return {
		batch: async (queries: readonly unknown[]) => {
			const snapshot = new Map(
				[...contractsTestState.rows].map(([table, rows]) => [
					table,
					rows.map((row) => ({ ...row })),
				]),
			);
			contractsTestState.queryCalls += 1;
			try {
				return queries.map((query) => {
					const rows = runBatchQuery(query);
					return { command: "BATCH", rows, rowCount: rows.length };
				});
			} catch (error) {
				contractsTestState.rows = snapshot;
				throw error;
			}
		},
		select: (selection?: Record<string, unknown>) => ({
			from: (table: Table) => selectQuery(table, contractRows(table), selection),
		}),
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
