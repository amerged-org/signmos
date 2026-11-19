import { wrapSigningTestDb } from "@/db/envelope/signing-test-db";
export type StoredRow = Record<string, unknown>;

type SelectQuery = Promise<StoredRow[]> & {
	where: (condition: unknown) => SelectQuery;
	limit: (count: number) => Promise<StoredRow[]>;
};

export const agentDocumentsTestState = {
	rows: new Map<unknown, StoredRow[]>(),
	r2Objects: new Map<string, Uint8Array>(),
};

function stringParams(condition: unknown): string[] {
	if (!condition || typeof condition !== "object") return [];
	if ("value" in condition && typeof condition.value === "string") return [condition.value];
	if (!("queryChunks" in condition) || !Array.isArray(condition.queryChunks)) return [];
	return condition.queryChunks.flatMap(stringParams);
}

function selectQuery(table: unknown, selected = rows(table)): SelectQuery {
	return Object.assign(Promise.resolve(selected), {
		where: (condition: unknown) => {
			const params = stringParams(condition);
			return selectQuery(
				table,
				selected.filter((row) => params.every((param) => Object.values(row).includes(param))),
			);
		},
		limit: async (count: number) => selected.slice(0, count),
	});
}

export function rows(table: unknown): StoredRow[] {
	const tableRows = agentDocumentsTestState.rows.get(table) ?? [];
	agentDocumentsTestState.rows.set(table, tableRows);
	return tableRows;
}

export const getAgentDocumentsTestDb = () =>
	wrapSigningTestDb(
		{
			select: () => ({ from: (table: unknown) => selectQuery(table) }),
			update: (table: unknown) => ({
				set: (values: StoredRow) => ({
					where: (condition: unknown) => ({
						returning: async () => {
							const params = stringParams(condition);
							const row = rows(table).find(
								(candidate) => typeof candidate.id === "string" && params.includes(candidate.id),
							);
							if (!row || (params.includes("active") && row.status !== "active")) return [];
							Object.assign(row, values);
							return [row];
						},
					}),
				}),
			}),
			insert: (table: unknown) => ({
				values: (value: StoredRow | StoredRow[]) => ({
					returning: async () => {
						const values = Array.isArray(value) ? value : [value];
						const inserted = values.map((row, index) => ({
							id: `80000000-0000-4000-8000-${String(rows(table).length + index + 1).padStart(12, "0")}`,
							createdAt: new Date("2026-07-17T10:00:00.000Z"),
							...row,
						}));
						rows(table).push(...inserted);
						return inserted;
					},
				}),
			}),
		},
		rows,
	);
