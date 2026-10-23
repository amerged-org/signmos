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
import { apiHono } from "@/hono/api";
import contractsEndpoint from "@/hono/api/contracts";
import { createHono } from "@/hono/factory";
import { createAdminCsrfToken, withAdminRequestScope } from "./auth";
import { authorizeHostedRequest } from "./auth-gate";
import { ContractError, type CreateContractRequest } from "./contracts-schema";
import { setOmhMailTransport } from "./mail";
import { createOmhDocumentsBucket, type OmhStorageEnv } from "./storage";

const token = "signmos_budget_test_owner_token";
const session = "secure-random-browser-session-budget-fixture";
const owner = "owner@example.com";
const recordId = "a0000000-0000-4000-8000-000000000002";
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const transferId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const app = createHono().route("/api/contracts", contractsEndpoint);

describe("bounded contract creation through private OMH adapters", () => {
	let physicalCalls: number;
	let queries: CustomerDatabaseQuery[];
	let batches: (readonly CustomerDatabaseQuery[])[];
	let input: CreateContractRequest;
	let env: Env;
	let storagePending: boolean;
	let mailUncertain: boolean;
	let mailRefusal: { status: number; code: string } | null;
	let commitRejected: boolean;
	let transactionThrows: number | null;
	let storageDown: boolean;
	let recordingDown: boolean;
	let deliveredKey: string | null;
	let browser: boolean;
	let csrfToken: string;
	const refusesRecording = (query: CustomerDatabaseQuery) =>
		recordingDown && query.text.startsWith('update "agentic_command_records"');

	beforeEach(async () => {
		physicalCalls = 0;
		queries = [];
		batches = [];
		storagePending = false;
		mailUncertain = false;
		mailRefusal = null;
		commitRejected = false;
		transactionThrows = null;
		storageDown = false;
		recordingDown = false;
		deliveredKey = null;
		browser = false;
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
			browser ? { ...tokenRow, token_hash: browserTokenHash, status: "internal" } : tokenRow;
		const database: CustomerDatabaseBinding = {
			query: async (value) => {
				physicalCalls++;
				const query = value as CustomerDatabaseQuery;
				queries.push(query);
				if (refusesRecording(query)) throw new Error("Too many subrequests");
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
				physicalCalls++;
				const batch = value as readonly CustomerDatabaseQuery[];
				batches.push(batch);
				// An infrastructure failure, for example a call limit: the runtime client reports it as
				// database_unavailable and the thrown text must never reach the response.
				if (batches.length === transactionThrows) throw new Error("Too many subrequests");
				if (batches.length === 2 && commitRejected)
					return { type: "ohmyhost.database-error/v1", sqlstate: "40001" };
				return batch.map((query) => result(query.text.startsWith("select") ? [{ guard: 1 }] : []));
			},
		};
		const storageEnv: OmhStorageEnv = {
			OHMYHOST_STORAGE_GATEWAY: {
				fetch: async (request) => {
					physicalCalls++;
					if (storageDown) throw new Error("Too many subrequests");
					const path = new URL(request.url).pathname;
					if (path === "/v1/uploads/complete")
						return Response.json({
							state: storagePending ? "pending" : "completed",
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
			physicalCalls++;
			expect(request.method).toBe("PUT");
			return new Response(null, { status: 200 });
		});
		setOmhMailTransport(async (request: Request) => {
			physicalCalls++;
			expect(batches).toHaveLength(1);
			expect(
				batches[0]?.some(
					(query) => query.text.includes('"signer_tokens"') && query.values.includes("revoked"),
				),
			).toBe(true);
			deliveredKey = request.headers.get("idempotency-key");
			if (mailRefusal)
				return Response.json({ code: mailRefusal.code }, { status: mailRefusal.status });
			return Response.json(
				mailUncertain
					? { state: "uncertain", request_id: transferId }
					: { state: "accepted", request_id: transferId, message_id: "message-1" },
				{ status: 202 },
			);
		});
		env = {
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
		input = {
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

	function create(
		router: { fetch(request: Request, env: Env): Response | Promise<Response> } = app,
	) {
		return withAdminRequestScope(() =>
			withDatabase(env, async () => {
				const request = new Request("https://sign.example.com/api/contracts", {
					method: "POST",
					headers: {
						...(browser
							? {
									cookie: `signmos_history_session=${session}`,
									origin: "https://sign.example.com",
									"x-csrf-token": csrfToken,
								}
							: { authorization: `Bearer ${token}` }),
						"content-type": "application/json",
						"idempotency-key": "bounded-contract-1",
					},
					body: JSON.stringify(input),
				});
				const gate = await authorizeHostedRequest(request, env);
				return "response" in gate ? gate.response : router.fetch(gate.request, env);
			}),
		);
	}

	it("sends a maximum-field contract within ten physical subrequests including authentication, files, mail and receipt", async () => {
		input.fields = Array.from({ length: 20 }, (_, index) => ({
			type: index === 0 ? "signature" : "date",
			page: 1,
			x: 72,
			y: 200,
			width: 180,
			height: 32,
		}));
		for (const mode of ["bearer", "browser"] as const) {
			browser = mode === "browser";
			physicalCalls = 0;
			queries = [];
			batches = [];
			const response = await create();
			expect(response.status, mode).toBe(201);
			expect(physicalCalls).toBeLessThanOrEqual(10);
			expect(queries).toHaveLength(4);
			expect(batches).toHaveLength(2);
			expect(batches[0]?.some((query) => query.text.includes('"envelope_artifact_versions"'))).toBe(
				true,
			);
			expect(deliveredKey).toMatch(/^sign\.[a-f0-9]{64}$/);
			for (const batch of batches) {
				expect(batch.length).toBeLessThanOrEqual(25);
				expect(batch[0]?.text).toContain("for update");
				const guardIndex = batch.findIndex((query) => query.text.includes("1 / case when exists"));
				expect(guardIndex).toBeGreaterThanOrEqual(0);
				expect(guardIndex).toBeLessThanOrEqual(1);
				for (const query of batch) expect(query.values.length).toBeLessThanOrEqual(100);
			}
			const body = await response.json();
			expect(body).toMatchObject({
				data: {
					title: input.title,
					status: "sent",
					recipients: [{ email: "ada@example.com", status: "sent" }],
				},
			});
			const receipt = batches[1]?.find((query) =>
				query.text.startsWith('update "agentic_command_records"'),
			);
			expect(receipt?.values).toContain(JSON.stringify(body));
		}
	});

	it("leaves the durable draft inactive when upload or mail confirmation is uncertain", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		for (const failure of ["storage", "mail"] as const) {
			batches = [];
			queries = [];
			physicalCalls = 0;
			deliveredKey = null;
			storagePending = failure === "storage";
			mailUncertain = failure === "mail";
			// An upload that is still pending leaves the command pending for the operator; an
			// uncertain mail is answered and recorded, so its key replays instead of staying "running".
			const response = await create();
			expect(response.status).toBe(failure === "storage" ? 500 : 503);
			if (failure === "mail") {
				const body = (await response.json()) as { error: Record<string, unknown> };
				expect(body).toMatchObject({ error: { code: "EMAIL_DELIVERY_UNCERTAIN" } });
				// No platform call raised it, so there is no platform code to report.
				expect(body.error).not.toHaveProperty("reason");
			}
			expect(batches).toHaveLength(1);
			expect(
				batches[0]?.some(
					(query) =>
						query.text.startsWith('update "agentic_command_records"') &&
						query.text.includes('"document_id"'),
				),
			).toBe(true);
			expect(deliveredKey === null).toBe(failure === "storage");
			expect(physicalCalls).toBeLessThanOrEqual(10);
		}
	});

	it.each([
		["bearer", 429, "mail_send_daily_limit", 429, "MAIL_DAILY_LIMIT", "mail_send_limit_exceeded"],
		[
			"bearer",
			423,
			"mail_reputation_suspended",
			423,
			"MAIL_SENDER_SUSPENDED",
			"mail_reputation_suspended",
		],
		["bearer", 402, "paid_plan_required", 402, "PAID_PLAN_REQUIRED", "paid_plan_required"],
		[
			"browser",
			402,
			"insufficient_organization_credits",
			402,
			"INSUFFICIENT_ORGANIZATION_CREDITS",
			"insufficient_organization_credits",
		],
		[
			"browser",
			402,
			"project_budget_exceeded",
			402,
			"PROJECT_BUDGET_EXCEEDED",
			"project_budget_exceeded",
		],
		[
			"bearer",
			400,
			"invalid_request",
			503,
			"PLATFORM_CONFIGURATION_INVALID",
			"gateway_request_invalid",
		],
		["browser", 502, "mail_rejected", 502, "EMAIL_DELIVERY_FAILED", "mail_rejected"],
		[
			"bearer",
			503,
			"mail_gateway_unavailable",
			503,
			"PLATFORM_SERVICE_UNAVAILABLE",
			"gateway_unavailable",
		],
	] as const)("answers and records a %s gateway refusal %i %s as HTTP %i %s with reason %s, within ten calls", async (mode, status, code, httpStatus, apiCode, reason) => {
		browser = mode === "browser";
		mailRefusal = { status, code };
		const response = await create();
		const body = await response.json();
		expect(response.status).toBe(httpStatus);
		expect(body).toMatchObject({ error: { code: apiCode, reason } });
		expect(physicalCalls).toBeLessThanOrEqual(10);
		// The draft stays inactive and the command is completed with this exact answer.
		expect(batches).toHaveLength(1);
		const receipt = queries.find(
			(query) =>
				query.text.startsWith('update "agentic_command_records"') &&
				query.values.includes(JSON.stringify(body)),
		);
		expect(receipt?.values).toContain("completed");
	});

	it.each([
		{
			phase: "database",
			fail: () => {
				transactionThrows = 1;
			},
			reason: "database_unavailable",
			says: [/did not confirm saving the draft/, /nothing was uploaded/, /no invitation was sent/],
			doesNotSay: /may or may not have been delivered/,
			mailReached: false,
		},
		{
			phase: "storage",
			fail: () => {
				storageDown = true;
			},
			reason: "gateway_unavailable",
			says: [/file storage did not confirm the PDF upload/, /no invitation was sent/],
			doesNotSay: /may or may not have been delivered/,
			mailReached: false,
		},
		{
			phase: "mail",
			fail: () => {
				mailRefusal = { status: 503, code: "mail_gateway_unavailable" };
			},
			reason: "gateway_unavailable",
			says: [/may or may not have been delivered/, /signing link stays inactive/],
			doesNotSay: /link may not work/,
			mailReached: true,
		},
		{
			phase: "activation",
			fail: () => {
				transactionThrows = 2;
			},
			reason: "database_unavailable",
			says: [/invitation was sent/, /link may not work/, /second email/],
			doesNotSay: /no invitation was sent/,
			mailReached: true,
		},
	])("records the platform code and says which step failed: $phase", async ({
		phase,
		fail,
		reason,
		says,
		doesNotSay,
		mailReached,
	}) => {
		fail();
		const response = await create();
		const body = (await response.json()) as {
			error: { code: string; message: string; reason?: string };
		};
		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({ code: "PLATFORM_SERVICE_UNAVAILABLE", reason });
		for (const pattern of says) expect(body.error.message).toMatch(pattern);
		expect(body.error.message).not.toMatch(doesNotSay);
		expect(JSON.stringify(body)).not.toContain("Too many subrequests");
		// The answer is recorded for the original key, exactly as sent.
		const receipt = queries.find(
			(query) =>
				query.text.startsWith('update "agentic_command_records"') &&
				query.values.includes(JSON.stringify(body)),
		);
		expect(receipt?.values).toContain("completed");
		// Only the mail and activation steps come after the request reached the mail gateway.
		expect(deliveredKey === null).toBe(!mailReached);
		// Activation is the tenth platform call, so recording its failure is an eleventh: under a
		// hosted limit of ten that write is refused too, and the caller then gets the unrecorded
		// PLATFORM_SERVICE_ERROR instead of this answer.
		expect(physicalCalls).toBeLessThanOrEqual(phase === "activation" ? 11 : 10);
	});

	it("records a contract error that a step raises under its own code and status", async () => {
		const put = async () => {
			throw new ContractError("SOURCE_PDF_TOO_LARGE", "Too large", 413);
		};
		env = { ...env, DOCUMENTS_BUCKET: { put } as unknown as R2Bucket };
		const response = await create();
		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toEqual({
			error: { code: "SOURCE_PDF_TOO_LARGE", message: "Too large" },
		});
	});

	it("answers a failure it cannot record as the platform's own error, with its reason", async () => {
		// A call limit makes every later call fail, including the write that records the failure.
		transactionThrows = 2;
		recordingDown = true;
		const response = await create(apiHono);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "PLATFORM_SERVICE_ERROR",
				message: "A platform service failed. Retry only if it is marked retryable.",
				reason: "database_unavailable",
				retryable: true,
			},
		});
		// The invitation went out before the activation failed.
		expect(deliveredKey).toMatch(/^sign\./);
	});

	it("hands the platform's own error, not the step marker, to the API error handler", async () => {
		commitRejected = true;
		const response = await create(apiHono);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "DATABASE_ERROR", reason: "40001", retryable: true },
		});
	});

	it("cannot report success when the final atomic activation and receipt transaction fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		commitRejected = true;
		expect((await create()).status).toBe(500);
		expect(batches).toHaveLength(2);
		expect(physicalCalls).toBeLessThanOrEqual(10);
		expect(deliveredKey).toMatch(/^sign\./);
	});
});

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
