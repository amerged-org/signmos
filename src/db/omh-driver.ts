import type {
	CustomerDatabaseClient,
	CustomerDatabaseParameter,
	CustomerDatabaseQueryResult,
} from "@ohmyhost/customer-runtime/database";
import type { PreparedQueryConfig } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { PgRemoteDatabase, PgRemoteSession, type PreparedQuery } from "drizzle-orm/pg-proxy";
import type { QueryWithTypings } from "drizzle-orm/sql";

interface BatchQuery {
	toSQL(): { sql: string; params: unknown[] };
}

type RemoteSession = PgRemoteSession<Record<string, never>, Record<string, never>>;
type QueryFields = Parameters<RemoteSession["prepareQuery"]>[1];
type QueryMetadata = Parameters<RemoteSession["prepareQuery"]>[5];
type QueryCacheConfig = Parameters<RemoteSession["prepareQuery"]>[6];

export type OmhDatabase = PgRemoteDatabase & {
	/** The history credential swap is one atomic transaction, never parallel writes. */
	batch(queries: readonly BatchQuery[]): Promise<readonly CustomerDatabaseQueryResult[]>;
};

export function createOmhDatabase(client: CustomerDatabaseClient): OmhDatabase {
	const dialect = new PgDialect();
	const session = new OmhSession(client, dialect);
	const database = new PgRemoteDatabase(dialect, session, undefined);
	return Object.assign(database, {
		batch(queries: readonly BatchQuery[]) {
			return client.transaction(
				queries.map((query) => {
					const built = query.toSQL();
					return { text: built.sql, values: built.params as CustomerDatabaseParameter[] };
				}),
			);
		},
	});
}

class OmhSession extends PgRemoteSession<Record<string, never>, Record<string, never>> {
	constructor(
		private readonly databaseClient: CustomerDatabaseClient,
		dialect: PgDialect,
	) {
		super(async () => ({ rows: [] }), dialect, undefined);
	}

	override prepareQuery<T extends PreparedQueryConfig>(
		query: QueryWithTypings,
		fields: QueryFields,
		name: string | undefined,
		isResponseInArrayMode: boolean,
		customResultMapper?: (rows: unknown[][]) => T["execute"],
		queryMetadata?: QueryMetadata,
		cacheConfig?: QueryCacheConfig,
	): PreparedQuery<T> {
		const session = new PgRemoteSession(
			async (text: string, params: unknown[], method: "all" | "execute") => {
				const count = fields?.length;
				if (method === "all" && count === undefined) {
					throw new Error("Database query has no ordered field metadata.");
				}
				// Unique CTE output names preserve duplicate column names in joins. OMH's
				// keyed RPC rows cannot otherwise represent Drizzle's positional results.
				const aliases = Array.from({ length: count ?? 0 }, (_, index) => `"c${index}"`);
				const statement =
					method === "all"
						? `with "__omh_result" (${aliases.join(", ")}) as (${text}) select * from "__omh_result"`
						: text;
				const result = await this.databaseClient.query({
					text: statement,
					values: params as CustomerDatabaseParameter[],
				});
				return {
					rows:
						method === "all"
							? result.rows.map((row) =>
									aliases.map((_, index) => {
										const key = `c${index}`;
										if (!Object.hasOwn(row, key)) {
											throw new Error("Database returned an incomplete ordered row.");
										}
										const value = row[key];
										return value instanceof Date ? value.toISOString() : value;
									}),
								)
							: [...result.rows],
				};
			},
			this.dialect,
			undefined,
		);
		return session.prepareQuery<T>(
			query,
			fields,
			name,
			isResponseInArrayMode,
			customResultMapper,
			queryMetadata,
			cacheConfig,
		);
	}
}
