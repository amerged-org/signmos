import { getTableColumns, SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	senderVerificationEmailRecords,
	senderVerificationTokens,
	signerTokens,
	sourceDocuments,
} from "./table";

type Row = Record<string, unknown>;
export function signingTestRow(table: Table, row: Row): Row {
	return Object.fromEntries(
		Object.entries(getTableColumns(table)).map(([property, column]) => {
			let value = row[property];
			if (value === undefined) {
				value = column.notNull ? defaultValue(property) : null;
				row[property] = value;
			}
			return [column.name, value instanceof Date ? value.toISOString() : value];
		}),
	);
}
function defaultValue(property: string): unknown {
	if (property === "id") return crypto.randomUUID();
	if (property === "signingMode") return "me_and_another_signer";
	if (property === "version") return 1;
	if (property === "originalFilename") return "document.pdf";
	if (property.endsWith("At")) return new Date("2026-05-20T08:00:00.000Z");
	return null;
}

/** Adapt the old domain DB fakes to the actual lazy transaction boundary. */
export function wrapSigningTestDb<Database extends object>(
	database: Database,
	rows: (table: unknown) => Row[],
	onCall?: () => void,
): Database {
	const call = (target: object, method: string, args: unknown[]): unknown => {
		const fn: unknown = Reflect.get(target, method);
		if (typeof fn !== "function") throw new Error(`Test database has no ${method}`);
		return Reflect.apply(fn, target, args);
	};
	const load = async (target: object): Promise<Row[]> => {
		const pending =
			"then" in target
				? target
				: "returning" in target
					? call(target, "returning", [])
					: "limit" in target
						? call(target, "limit", [10000])
						: [];
		const result: unknown = await pending;
		return Array.isArray(result) ? (result as Row[]) : [];
	};
	const project = (
		table: Table,
		selected: Row[],
		selection?: Record<string, unknown>,
		condition?: unknown,
	): Row[] => {
		if (
			table === finalDocuments &&
			selection &&
			"finalizationData" in selection &&
			condition instanceof SQL
		) {
			const params = new PgDialect().sqlToQuery(condition).params;
			const token = params.find((value) => typeof value === "string");
			const now = params.find((value) => value instanceof Date) as Date | undefined;
			return rows(finalDocuments)
				.filter((document) => {
					if (
						!rows(envelopes).some(
							(envelope) => envelope.id === document.envelopeId && envelope.status === "completed",
						)
					)
						return false;
					if (
						rows(auditEvents).some(
							(event) =>
								event.envelopeId === document.envelopeId &&
								event.eventType === "envelope.deletion_started",
						)
					)
						return false;
					return (
						document.id === token ||
						rows(signerTokens).some(
							(signer) =>
								signer.envelopeId === document.envelopeId &&
								signer.token === token &&
								signer.status === "active" &&
								signer.expiresAt instanceof Date &&
								signer.expiresAt > (now ?? new Date()),
						)
					);
				})
				.map((document) => ({
					...document,
					finalizationData: Object.fromEntries(
						[
							["sources", sourceDocuments],
							["fields", envelopeFields],
							["values", fieldValues],
							["events", auditEvents],
							["recipients", envelopeRecipients],
							["tokens", signerTokens],
							["senderTokens", senderVerificationTokens],
						].map(([key, sourceTable]) => [
							key,
							rows(sourceTable)
								.filter((row) => row.envelopeId === document.envelopeId)
								.map((row) => signingTestRow(sourceTable as Table, row)),
						]),
					),
				}));
		}
		if (condition instanceof SQL) {
			const query = new PgDialect().sqlToQuery(condition);
			const columns = getTableColumns(table);
			const equalities = [...query.sql.matchAll(/"[^".]+"\."([^".]+)" = \$(\d+)/g)];
			selected = rows(table).filter((row) =>
				equalities.every((match) => {
					const property = Object.entries(columns).find(
						([, column]) => column.name === match[1],
					)?.[0];
					return !property || row[property] === query.params[Number(match[2]) - 1];
				}),
			);
			if (query.sql.includes("envelope.deletion_started"))
				selected = selected.filter(
					(row) =>
						!rows(auditEvents).some(
							(event) =>
								event.envelopeId === (table === envelopes ? row.id : row.envelopeId) &&
								event.eventType === "envelope.deletion_started",
						),
				);
		}
		if (table !== signerTokens || !selection || !("envelopeStatus" in selection)) return selected;
		return selected.map((token) => ({
			...token,
			deletionPending: rows(auditEvents).some(
				(event) =>
					event.envelopeId === token.envelopeId && event.eventType === "envelope.deletion_started",
			),
			envelopeStatus: rows(envelopes).find((row) => row.id === token.envelopeId)?.status,
			completionContext: {
				envelope: signingTestRow(
					envelopes,
					rows(envelopes).find((row) => row.id === token.envelopeId) ?? {},
				),
				fields: rows(envelopeFields)
					.filter((row) => row.envelopeId === token.envelopeId)
					.map((row) => signingTestRow(envelopeFields, row)),
				recipients: rows(envelopeRecipients)
					.filter((row) => row.envelopeId === token.envelopeId)
					.map((row) => signingTestRow(envelopeRecipients, row)),
				saved: rows(fieldValues)
					.filter(
						(row) => row.envelopeId === token.envelopeId && row.recipientId === token.recipientId,
					)
					.map((row) => signingTestRow(fieldValues, row)),
			},
		}));
	};
	function returningRows(build: () => object, table: Table): object {
		const original = build();
		return "returning" in original
			? (call(original, "returning", []) as object)
			: Promise.resolve(original).then(() => rows(table));
	}
	function executeProjected(
		build: () => object,
		table: Table,
		selection?: Record<string, unknown>,
		condition?: unknown,
	) {
		return (resolve: (value: Row[]) => unknown, reject: (reason: unknown) => unknown) => {
			onCall?.();
			return load(build())
				.then((result) => project(table, result, selection, condition))
				.then(resolve, reject);
		};
	}
	const wrap = (
		build: () => object,
		table: Table,
		selection?: Record<string, unknown>,
		condition?: unknown,
	): object =>
		new Proxy(
			{},
			{
				get(_target, property) {
					switch (property) {
						case "testTable":
							return table;
						case "run":
							return async () => project(table, await load(build()), selection, condition);
						case "onConflictDoNothing":
							return () => wrap(build, table, selection, condition);
						case "returning":
							return () => wrap(() => returningRows(build, table), table, selection);
						case "toSQL":
							return () => ({ sql: "test query", params: [] });
						case "then":
							return executeProjected(build, table, selection, condition);
						default:
							return (...args: unknown[]) =>
								wrap(
									() => call(build(), String(property), args) as object,
									table,
									selection,
									property === "where" ? args[0] : condition,
								);
					}
				},
			},
		);
	const insert = async (table: Table, input: Row | Row[]): Promise<Row[]> => {
		const builder = call(database, "insert", [table]) as object;
		return load(call(builder, "values", [input]) as object);
	};
	const update = async (table: Table, input: Row, condition: unknown) => {
		const builder = call(database, "update", [table]) as object;
		const setter = call(builder, "set", [input]) as object;
		await load(call(setter, "where", [condition]) as object);
		return [];
	};
	async function recordDeletionIntent(params: unknown[]): Promise<Row[]> {
		if (
			!rows(auditEvents).some(
				(row) => row.envelopeId === params[0] && row.eventType === "envelope.deletion_started",
			)
		) {
			await insert(auditEvents, {
				envelopeId: params[0],
				recipientId: null,
				eventType: "envelope.deletion_started",
				message: params[1],
			});
		}
		return [];
	}
	function hasFinalizableEnvelope(envelopeId: unknown): boolean {
		return rows(envelopes).some(
			(row) => row.id === envelopeId && ["sent", "completed"].includes(String(row.status)),
		);
	}
	async function retainArtifact(params: unknown[]): Promise<Row[]> {
		const { envelopeArtifactVersions } = await import("./artifact-versions");
		const envelopeId = String(params[0]);
		const r2Key = String(params[1]);
		if (!hasFinalizableEnvelope(envelopeId)) return [];
		if (!rows(envelopeArtifactVersions).some((row) => row.r2Key === r2Key))
			await insert(envelopeArtifactVersions, { envelopeId, r2Key });
		return [{ id: "retained" }];
	}
	async function commitArtifact(params: unknown[]): Promise<Row[]> {
		const [id, envelopeId, r2Key, sha256, byteSize, contentType] = params;
		if (!hasFinalizableEnvelope(envelopeId)) return [];
		if (!rows(finalDocuments).some((row) => row.envelopeId === envelopeId))
			await insert(finalDocuments, { id, envelopeId, r2Key, sha256, byteSize, contentType });
		return [];
	}
	async function recordPartnerCompletionEmail(params: unknown[]): Promise<Row[]> {
		const [envelopeId, recipientId, tokenId, email, fallbackUrl, documentId] = params;
		if (rows(finalDocuments).some((row) => row.id === documentId))
			await insert(emailSendRecords, {
				envelopeId,
				recipientId,
				tokenId,
				email,
				kind: "completion",
				fallbackUrl,
			});
		return [];
	}
	async function recordSenderCompletionEmail(params: unknown[]): Promise<Row[]> {
		const [envelopeId, tokenId, email, fallbackUrl, documentId] = params;
		if (rows(finalDocuments).some((row) => row.id === documentId))
			await insert(senderVerificationEmailRecords, {
				envelopeId,
				tokenId,
				email,
				kind: "completion",
				fallbackUrl,
			});
		return [];
	}
	async function completeEnvelope(params: unknown[]): Promise<Row[]> {
		if (rows(envelopes).some((row) => row.id === params[0] && row.status === "sent"))
			await update(envelopes, { status: "completed" }, undefined);
		return [];
	}
	const statementHandlers: Array<{
		matches(statement: string): boolean;
		run(params: unknown[]): Row[] | Promise<Row[]>;
	}> = [
		{
			matches: (statement) => statement.includes("signing-delete-intent"),
			run: recordDeletionIntent,
		},
		{
			matches: (statement) => statement.includes("signing-record-guard"),
			run: () => [{ allowed: 1 }],
		},
		{
			matches: (statement) => statement.includes("signing-register-artifact"),
			run: retainArtifact,
		},
		{ matches: (statement) => statement.includes("signing-commit-artifact"), run: commitArtifact },
		{
			matches: (statement) => statement.startsWith("insert into email_send_records"),
			run: recordPartnerCompletionEmail,
		},
		{
			matches: (statement) => statement.startsWith("insert into sender_verification_email_records"),
			run: recordSenderCompletionEmail,
		},
		{
			matches: (statement) => statement.startsWith("update envelopes set status = 'completed'"),
			run: completeEnvelope,
		},
		{
			matches: (statement) => statement.startsWith("select f.* from final_documents"),
			run: (params) =>
				rows(finalDocuments)
					.filter((row) => row.envelopeId === params[0])
					.map((row) => signingTestRow(finalDocuments, row)),
		},
		{
			matches: (statement) => statement.startsWith("select id from signer_tokens"),
			run: (params) => rows(signerTokens).filter((row) => row.id === params[0]),
		},
		{
			matches: (statement) => statement.startsWith("select id from envelopes"),
			run: (params) => rows(envelopes).filter((row) => row.id === params[0]),
		},
	];
	const raw = async (query: { toSQL(): { sql: string; params: unknown[] } }): Promise<Row[]> => {
		const { sql: statement, params } = query.toSQL();
		const handler = statementHandlers.find((candidate) => candidate.matches(statement));
		if (!handler) throw new Error(`Unsupported test signing statement: ${statement}`);
		return handler.run(params);
	};

	return {
		...database,
		select: (selection?: Record<string, unknown>) => ({
			from: (table: Table) => {
				return wrap(
					() => {
						const builder = call(database, "select", [selection]) as object;
						return call(builder, "from", [table]) as object;
					},
					table,
					selection,
				);
			},
		}),
		insert: (table: Table) => wrap(() => call(database, "insert", [table]) as object, table),
		update: (table: Table) => wrap(() => call(database, "update", [table]) as object, table),
		batch: async (
			queries: Array<{
				run?(): Promise<Row[]>;
				testTable?: Table;
				toSQL(): { sql: string; params: unknown[] };
			}>,
		) => {
			onCall?.();
			const results = [];
			for (const query of queries) {
				const table = query.testTable;
				const result =
					query.run && table
						? (await query.run()).map((row) => signingTestRow(table, row))
						: await raw(query);
				results.push({ rows: result, rowCount: result.length, command: "SELECT" });
			}
			return results;
		},
	} as unknown as Database;
}
