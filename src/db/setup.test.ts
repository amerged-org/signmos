import type { CustomerDatabaseBinding } from "@ohmyhost/customer-runtime/database";
import { count, eq, sql } from "drizzle-orm";
import { integer, jsonb, pgTable, timestamp } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { getDb, withDatabase } from "./setup";

const records = pgTable("adapter_records", {
	id: integer("id").primaryKey(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	payload: jsonb("payload").$type<{ label: string }>(),
});
const owners = pgTable("adapter_owners", { id: integer("id").primaryKey() });

function result(rows: readonly Record<string, unknown>[] = [], command = "SELECT") {
	return { command, rows, rowCount: rows.length };
}

function binding(queryResult: unknown = result()): CustomerDatabaseBinding & {
	query: ReturnType<typeof vi.fn>;
	transaction: ReturnType<typeof vi.fn>;
} {
	return {
		query: vi.fn(async () => queryResult),
		transaction: vi.fn(async (queries: readonly unknown[]) => queries.map(() => result())),
	};
}

describe("OMH request database boundary", () => {
	it("renders public request scopes without initializing or requiring a database binding", async () => {
		await expect(
			withDatabase(
				{ OHMYHOST_DATABASE: undefined as unknown as CustomerDatabaseBinding },
				async () => "public login and liveness response",
			),
		).resolves.toBe("public login and liveness response");
		expect(() => getDb()).toThrow("outside an active request scope");
	});

	it("requires an active request scope and an actual private binding", async () => {
		expect(() => getDb()).toThrow("outside an active request scope");
		await expect(async () =>
			withDatabase({ OHMYHOST_DATABASE: null as unknown as CustomerDatabaseBinding }, async () => {
				await getDb().execute(sql`select 1`);
			}),
		).rejects.toMatchObject({ code: "database_binding_missing" });
	});

	it("keeps parameterized SQL and decodes ordered Date/JSON fields", async () => {
		const createdAt = new Date("2026-10-21T12:30:00.000Z");
		const database = binding(result([{ c2: { label: "contract" }, c0: 42, c1: createdAt }]));
		const rows = await withDatabase({ OHMYHOST_DATABASE: database }, async () =>
			getDb()
				.select({ id: records.id, createdAt: records.createdAt, payload: records.payload })
				.from(records)
				.where(eq(records.id, 42)),
		);
		expect(rows).toEqual([{ id: 42, createdAt, payload: { label: "contract" } }]);
		expect(rows[0]?.createdAt).toBeInstanceOf(Date);
		expect(database.query).toHaveBeenCalledWith({
			text: expect.stringContaining('with "__omh_result" ("c0", "c1", "c2") as (select'),
			values: [42],
		});
	});

	it("preserves duplicate SQL column names in joined selections", async () => {
		const database = binding(result([{ c1: 200, c0: 100 }]));
		const rows = await withDatabase({ OHMYHOST_DATABASE: database }, async () =>
			getDb()
				.select({ record: records.id, owner: owners.id })
				.from(records)
				.innerJoin(owners, eq(records.id, owners.id)),
		);
		expect(rows).toEqual([{ record: 100, owner: 200 }]);
		expect(database.query).toHaveBeenCalledWith({
			text: expect.stringContaining(
				'("c0", "c1") as (select "adapter_records"."id", "adapter_owners"."id"',
			),
			values: [],
		});
	});

	it("decodes aggregate counts selected by list API queries", async () => {
		const database = binding(result([{ c0: "23" }]));
		const rows = await withDatabase({ OHMYHOST_DATABASE: database }, async () =>
			getDb().select({ total: count() }).from(records),
		);
		expect(rows).toEqual([{ total: 23 }]);
	});

	it("supports typed returning rows and raw health reads", async () => {
		const createdAt = "2026-10-21T12:30:00.000Z";
		const database = binding(result([{ c0: 42, c1: createdAt, c2: null }], "INSERT"));
		await withDatabase({ OHMYHOST_DATABASE: database }, async () => {
			const inserted = await getDb()
				.insert(records)
				.values({ id: 42, createdAt: new Date(createdAt) })
				.returning();
			expect(inserted).toEqual([{ id: 42, createdAt: new Date(createdAt), payload: null }]);
			database.query.mockResolvedValueOnce(result([{ healthy: 1 }]));
			await expect(getDb().execute(sql`select 1 as healthy`)).resolves.toEqual([{ healthy: 1 }]);
		});
	});

	it("keeps database SQLSTATE failures available through Drizzle's cause", async () => {
		const database = binding({ type: "ohmyhost.database-error/v1", sqlstate: "23505" });
		await expect(
			withDatabase({ OHMYHOST_DATABASE: database }, async () =>
				getDb().select({ id: records.id }).from(records),
			),
		).rejects.toMatchObject({ cause: { code: "23505", name: "CustomerDatabaseError" } });
	});

	it("rejects malformed ordered rows instead of silently returning undefined fields", async () => {
		const database = binding(result([{ c1: 1 }]));
		await expect(
			withDatabase({ OHMYHOST_DATABASE: database }, async () =>
				getDb().select({ id: records.id }).from(records),
			),
		).rejects.toMatchObject({ cause: { message: "Database returned an incomplete ordered row." } });
	});

	it("uses the binding transaction for the complete credential swap", async () => {
		const database = binding();
		await withDatabase({ OHMYHOST_DATABASE: database }, async () => {
			const db = getDb();
			await db.batch([
				db.update(records).set({ id: 2 }).where(eq(records.id, 1)),
				db.update(records).set({ id: 3 }).where(eq(records.id, 2)),
			]);
		});
		expect(database.query).not.toHaveBeenCalled();
		expect(database.transaction).toHaveBeenCalledOnce();
		expect(database.transaction).toHaveBeenCalledWith([
			{ text: expect.stringContaining('update "adapter_records"'), values: [2, 1] },
			{ text: expect.stringContaining('update "adapter_records"'), values: [3, 2] },
		]);
	});

	it("propagates a failed transaction without falling back to independent writes", async () => {
		const database = binding();
		database.transaction.mockResolvedValueOnce({
			type: "ohmyhost.database-error/v1",
			sqlstate: "40001",
		});
		await expect(
			withDatabase({ OHMYHOST_DATABASE: database }, async () => {
				const db = getDb();
				await db.batch([db.update(records).set({ id: 2 }).where(eq(records.id, 1))]);
			}),
		).rejects.toMatchObject({ code: "40001", retryable: true });
		expect(database.query).not.toHaveBeenCalled();
	});

	it("isolates simultaneous asynchronous request bindings and restores nested scopes", async () => {
		const first = binding(result([{ c0: 1 }]));
		const second = binding(result([{ c0: 2 }]));
		const rows = await Promise.all([
			withDatabase({ OHMYHOST_DATABASE: first }, async () => {
				await Promise.resolve();
				const outer = getDb();
				await withDatabase({ OHMYHOST_DATABASE: second }, async () => {
					await Promise.resolve();
					expect(getDb()).not.toBe(outer);
				});
				expect(getDb()).toBe(outer);
				return getDb().select({ id: records.id }).from(records).where(eq(records.id, 1));
			}),
			withDatabase({ OHMYHOST_DATABASE: second }, async () => {
				await Promise.resolve();
				return getDb().select({ id: records.id }).from(records).where(eq(records.id, 2));
			}),
		]);
		expect(rows).toEqual([[{ id: 1 }], [{ id: 2 }]]);
		expect(first.query).toHaveBeenCalledWith({ text: expect.any(String), values: [1] });
		expect(second.query).toHaveBeenCalledWith({ text: expect.any(String), values: [2] });
		expect(() => getDb()).toThrow("outside an active request scope");
	});
});
