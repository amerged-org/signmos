import { AsyncLocalStorage } from "node:async_hooks";
import {
	type CustomerDatabaseBinding,
	createPrivateDatabaseClient,
} from "@ohmyhost/customer-runtime/database";
import { createOmhDatabase, type OmhDatabase } from "./omh-driver";

interface RequestDatabase {
	readonly binding: CustomerDatabaseBinding;
	database?: OmhDatabase;
}

const databaseContext = new AsyncLocalStorage<RequestDatabase>();

export interface DatabaseEnv {
	readonly OHMYHOST_DATABASE: CustomerDatabaseBinding;
}

/** Bind persistence to this request's private OMH service, including async work. */
export function withDatabase<Result>(
	env: DatabaseEnv,
	run: () => Promise<Result>,
): Promise<Result> {
	return databaseContext.run({ binding: env.OHMYHOST_DATABASE }, run);
}

export function getDb(): OmhDatabase {
	const scope = databaseContext.getStore();
	if (!scope) throw new Error("Database is outside an active request scope.");
	scope.database ??= createOmhDatabase(createPrivateDatabaseClient(scope.binding));
	return scope.database;
}
