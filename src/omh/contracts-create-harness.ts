import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { getTableColumns, type Table } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { fingerprintAgentCommand } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { agenticApiTokens, agenticCommandRecords } from "@/db/agentic-access/table";
import { hashHistoryCredential } from "@/db/history-access/request";
import { historySessions } from "@/db/history-access/table";
import { withDatabase } from "@/db/setup";
import contractsEndpoint from "@/hono/api/contracts";
import { createHono } from "@/hono/factory";
import { createAdminCsrfToken, withAdminRequestScope } from "./auth";
import { authorizeHostedRequest } from "./auth-gate";
import type { CreateContractRequest } from "./contracts-schema";
import { setOmhMailTransport } from "./mail";
import { createOmhDocumentsBucket, type OmhStorageEnv } from "./storage";

const token = "signmos_budget_test_owner_token";
const session = "secure-random-browser-session-budget-fixture";
const owner = "owner@example.com";
const recordId = "a0000000-0000-4000-8000-000000000002";
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const transferId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const app = createHono().route("/api/contracts", contractsEndpoint);

type Router = { fetch(request: Request, env: Env): Response | Promise<Response> };

/**
 * One contract-creation request through the real hosted gate, the real private-client adapters and
 * doubles for the platform behind them: the project database, the file storage and the mail
 * gateway. Every call that reaches a double is one physical subrequest.
 */
export interface CreationHarness {
	/**
	 * What the request has called so far, in order: "database.query", "database.transaction",
	 * "storage.gateway" (reserve and complete), "storage.upload" (the signed PUT) and "mail.send".
	 * Each is one physical subrequest.
	 */
	calls: string[];
	readonly physicalCalls: number;
	queries: CustomerDatabaseQuery[];
	batches: (readonly CustomerDatabaseQuery[])[];
	/** The idempotency key of the mail the gateway double received. */
	deliveredKey: string | null;
	input: CreateContractRequest;
	env: Env;
	/** The request authenticates with the browser session instead of the Bearer token. */
	browser: boolean;
	storagePending: boolean;
	mailUncertain: boolean;
	mailRefusal: { status: number; code: string } | null;
	commitRejected: boolean;
	/** The transaction with this number (1 = the draft, 2 = the activation) fails like a call limit. */
	transactionThrows: number | null;
	storageDown: boolean;
	recordingDown: boolean;
	/** The insert that claims the idempotency key fails like a call limit, or with a SQL error. */
	claimFailure: "unavailable" | "statement" | null;
	create(router?: Router): Promise<Response>;
}

/** Registers the per-test setup and teardown; call it inside a `describe`. */
export function useCreationHarness(): CreationHarness {
	let csrfToken = "";
	const harness: CreationHarness = {
		calls: [],
		get physicalCalls() {
			return harness.calls.length;
		},
		queries: [],
		batches: [],
		deliveredKey: null,
		input: { title: "", recipient: { name: "", email: "" }, pdf: { filename: "", base64: "" } },
		env: {} as unknown as Env,
		browser: false,
		storagePending: false,
		mailUncertain: false,
		mailRefusal: null,
		commitRejected: false,
		transactionThrows: null,
		storageDown: false,
		recordingDown: false,
		claimFailure: null,
		create(router = app) {
			return withAdminRequestScope(() =>
				withDatabase(harness.env, async () => {
					const request = new Request("https://sign.example.com/api/contracts", {
						method: "POST",
						headers: {
							...(harness.browser
								? {
										cookie: `signmos_history_session=${session}`,
										origin: "https://sign.example.com",
										"x-csrf-token": csrfToken,
									}
								: { authorization: `Bearer ${token}` }),
							"content-type": "application/json",
							"idempotency-key": "bounded-contract-1",
						},
						body: JSON.stringify(harness.input),
					});
					const gate = await authorizeHostedRequest(request, harness.env);
					return "response" in gate ? gate.response : router.fetch(gate.request, harness.env);
				}),
			);
		},
	};
	/**
	 * What the database double answers instead of the query when the scenario makes it fail:
	 * a thrown error is an infrastructure failure such as a call limit (the runtime client reports
	 * it as database_unavailable and the thrown text must never reach a response), an answer is a
	 * SQL error of the statement itself.
	 */
	const failedAnswer = (query: CustomerDatabaseQuery): unknown => {
		if (harness.recordingDown && query.text.startsWith('update "agentic_command_records"'))
			throw new Error("Too many subrequests");
		// A statement with `returning` reaches the double wrapped in a result CTE.
		if (harness.claimFailure && query.text.includes('insert into "agentic_command_records"')) {
			if (harness.claimFailure === "unavailable") throw new Error("Too many subrequests");
			return { type: "ohmyhost.database-error/v1", sqlstate: "23505" };
		}
		return undefined;
	};

	beforeEach(async () => {
		harness.calls = [];
		harness.queries = [];
		harness.batches = [];
		harness.storagePending = false;
		harness.mailUncertain = false;
		harness.mailRefusal = null;
		harness.commitRejected = false;
		harness.transactionThrows = null;
		harness.storageDown = false;
		harness.recordingDown = false;
		harness.claimFailure = null;
		harness.deliveredKey = null;
		harness.browser = false;
		csrfToken = await createAdminCsrfToken(session);
		const browserTokenHash = await fingerprintAgentCommand({
			kind: "contracts-internal",
			email: owner,
		});
		const sessionHash = await hashHistoryCredential(session);
		const tokenRow: Record<string, unknown> = {
			id: "a0000000-0000-4000-8000-000000000001",
			email: owner,
			name: "Integration",
			token_hash: await hashAgenticCredential(token),
			token_hint: "signmos_…token",
			status: "active",
			active_slot: 1,
			last_used_at: null,
			revoked_at: null,
			created_at: new Date().toISOString(),
		};
		const currentTokenRow = (): Record<string, unknown> =>
			harness.browser
				? { ...tokenRow, token_hash: browserTokenHash, status: "internal" }
				: tokenRow;
		const database: CustomerDatabaseBinding = {
			query: async (value) => {
				harness.calls.push("database.query");
				const query = value as CustomerDatabaseQuery;
				harness.queries.push(query);
				const failed = failedAnswer(query);
				if (failed !== undefined) return failed;
				if (query.text.includes('"agentic_api_tokens"')) {
					return result([orderedRow(agenticApiTokens, currentTokenRow())]);
				}
				if (query.text.includes('"history_sessions"')) {
					return result([
						orderedRow(historySessions, {
							id: recordId,
							email: owner,
							session_hash: sessionHash,
							status: "active",
							expires_at: new Date(Date.now() + 60_000).toISOString(),
						}),
					]);
				}
				if (query.text.includes('"agentic_command_records"')) {
					return result([orderedRow(agenticCommandRecords, { id: recordId })]);
				}
				if (query.text.includes('"agentic_security_events"')) return result();
				throw new Error("Unexpected private database read during contract creation");
			},
			transaction: async (value) => {
				harness.calls.push("database.transaction");
				const batch = value as readonly CustomerDatabaseQuery[];
				harness.batches.push(batch);
				// An infrastructure failure, for example a call limit: the runtime client reports it as
				// database_unavailable and the thrown text must never reach the response.
				if (harness.batches.length === harness.transactionThrows)
					throw new Error("Too many subrequests");
				if (harness.batches.length === 2 && harness.commitRejected)
					return { type: "ohmyhost.database-error/v1", sqlstate: "40001" };
				return batch.map((query) => result(query.text.startsWith("select") ? [{ guard: 1 }] : []));
			},
		};
		const storageEnv: OmhStorageEnv = {
			OHMYHOST_STORAGE_GATEWAY: {
				fetch: async (request) => {
					harness.calls.push("storage.gateway");
					if (harness.storageDown) throw new Error("Too many subrequests");
					const path = new URL(request.url).pathname;
					if (path === "/v1/uploads/complete")
						return Response.json({
							state: harness.storagePending ? "pending" : "completed",
							transfer_id: transferId,
						});
					const body = (await request.json()) as { objectKey: string; contentLength: number };
					return Response.json({
						state: "ready",
						transfer_id: transferId,
						capability: {
							operation: "PUT",
							objectKey: body.objectKey,
							url: "https://upload.example.com/contract",
							expiresAt: new Date(Date.now() + 60_000).toISOString(),
							expectedContentLength: body.contentLength,
							requiredHeaders: { "content-type": "application/pdf" },
						},
					});
				},
			},
			OHMYHOST_STORAGE_GATEWAY_URL: "https://private-storage.example.com",
			OHMYHOST_STORAGE_KEY: "s".repeat(43),
			OHMYHOST_PROJECT_ID: projectId,
			OHMYHOST_ENVIRONMENT_ID: transferId,
		};
		vi.stubGlobal("fetch", async (request: Request) => {
			harness.calls.push("storage.upload");
			expect(request.method).toBe("PUT");
			return new Response(null, { status: 200 });
		});
		setOmhMailTransport(async (request: Request) => {
			harness.calls.push("mail.send");
			expect(harness.batches).toHaveLength(1);
			expect(
				harness.batches[0]?.some(
					(query) => query.text.includes('"signer_tokens"') && query.values.includes("revoked"),
				),
			).toBe(true);
			harness.deliveredKey = request.headers.get("idempotency-key");
			if (harness.mailRefusal)
				return Response.json(
					{ code: harness.mailRefusal.code },
					{ status: harness.mailRefusal.status },
				);
			return Response.json(
				harness.mailUncertain
					? { state: "uncertain", request_id: transferId }
					: { state: "accepted", request_id: transferId, message_id: "message-1" },
				{ status: 202 },
			);
		});
		harness.env = {
			...storageEnv,
			OHMYHOST_DATABASE: database,
			SIGN_ADMIN_EMAILS: owner,
			APP_BASE_URL: "https://sign.example.com",
			SIGN_FROM_EMAIL: "contracts@mail.example.com",
			SIGN_REPLY_TO_EMAIL: owner,
			OHMYHOST_MAIL_GATEWAY_URL: "https://private-mail.example.com",
			OHMYHOST_MAIL_KEY: "m".repeat(43),
			DOCUMENTS_BUCKET: createOmhDocumentsBucket(storageEnv),
		} as unknown as Env;
		const pdf = await PDFDocument.create();
		pdf.addPage([612, 792]);
		harness.input = {
			title: "Vertrag",
			recipient: { name: "Ada", email: "ada@example.com" },
			pdf: { filename: "vertrag.pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
		};
	});
	afterEach(() => {
		setOmhMailTransport(null);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	return harness;
}

function result(rows: Record<string, unknown>[] = []) {
	return { command: "TEST", rows, rowCount: rows.length };
}
function orderedRow(table: Table, row: Record<string, unknown>) {
	return Object.fromEntries(
		Object.values(getTableColumns(table)).map((column, index) => [
			`c${index}`,
			row[column.name] ?? null,
		]),
	);
}
