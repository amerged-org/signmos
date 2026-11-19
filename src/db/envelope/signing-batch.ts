import { getTableColumns, type SQL, sql, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getDb } from "@/db/setup";

type Row = Record<string, unknown>;
export interface SigningBatchQuery {
	toSQL(): { sql: string; params: unknown[] };
}
export interface SigningBatchRead {
	query: SigningBatchQuery;
	table: Table;
}
const dialect = new PgDialect();

/** Keep bounded dependent reads/writes in one private database transaction. */
export async function signingBatch(
	operations: readonly (SigningBatchQuery | SigningBatchRead)[],
): Promise<Row[][]> {
	const results = await getDb().batch(
		operations.map((operation) => ("query" in operation ? operation.query : operation)),
	);
	return operations.map((operation, index) => {
		const rows = results[index]?.rows;
		if (!rows) throw new Error("Incomplete signing transaction response");
		if (!("query" in operation)) return [...rows];
		return rows.map((row) => decodeSigningRow(operation.table, row));
	});
}

export function signingStatement(fragment: SQL): SigningBatchQuery {
	return { toSQL: () => dialect.sqlToQuery(fragment) };
}

export function decodeSigningRow(table: Table, row: Row): Row {
	return Object.fromEntries(
		Object.entries(getTableColumns(table)).map(([property, column]) => {
			if (!Object.hasOwn(row, column.name)) throw new Error("Incomplete signing database row");
			const value = row[column.name];
			return [
				property,
				value === null
					? null
					: column.mapFromDriverValue(value instanceof Date ? value.toISOString() : value),
			];
		}),
	);
}

/** The marker closes uploads before deletion inventories immutable private locators. */
export function noEnvelopeDeletion(envelopeId: string | SQL): SQL {
	return sql`not exists (select 1 from audit_events deletion where deletion.envelope_id = ${envelopeId} and deletion.event_type = 'envelope.deletion_started')`;
}

export function isSigningGuardFailure(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if ("code" in error && error.code === "22012") return true;
	return "cause" in error && error.cause !== error && isSigningGuardFailure(error.cause);
}
