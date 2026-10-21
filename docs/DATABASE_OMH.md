# OMH database port

Runtime database access uses the deployment's `OHMYHOST_DATABASE` private binding through `@ohmyhost/customer-runtime/database`. The application needs no PostgreSQL URL, database password, Neon HTTP endpoint, socket driver, or direct database egress.

The Worker entry calls `withDatabase(env, callback)` around each request. `getDb()` resolves the Drizzle database from `AsyncLocalStorage`; overlapping requests and nested scopes cannot overwrite one another's bindings. Calling `getDb()` outside a scope fails explicitly.

`src/db/omh-driver.ts` bridges Drizzle's PostgreSQL proxy driver to the private binding. Selected/returning fields use a CTE with unique positional column names so joined columns with the same SQL name remain distinct. Result fields are ordered from Drizzle's prepared metadata, independent of object key order. Date values return through Drizzle's timestamp decoder; JSON values retain their types. SQLSTATE failures retain the runtime error in Drizzle's `cause`.

The existing My Documents history credential swap uses `db.batch`. Its two non-returning updates go to one OMH `transaction` call. The compatibility method returns raw transaction results and must not be used to decode `returning` rows. Interactive transactions remain unsupported by the proxy driver; use an explicit bounded `withConnection` implementation if a future feature needs one, keeping email/network work outside the connection scope.

`database/omh-migrations/20261021120000_signmos.sql` is a fresh schema derived from the upstream production baseline. It creates 27 tables, all 33 foreign keys, and 12 separate unique indexes. Tables are ordered by their dependencies and foreign keys are inline. The 39 statements pass OMH's expand-only migration admission and apply successfully to an isolated PostgreSQL database. The original generated upstream migrations remain intact and are not the OMH deployment migration directory.

The adapter's focused tests cover scoped bindings, concurrent/nested request isolation, parameterized queries, timestamp/JSON decoding, joined duplicate column names, typed returning rows, malformed result rejection, raw reads, SQLSTATE propagation, and atomic batch dispatch/failure. Live deployed authorization and application flows are separate verification requirements.
