import {
	CustomerDatabaseError,
	CustomerRuntimeError,
	CustomerRuntimeGatewayError,
} from "@ohmyhost/customer-runtime";
import { DrizzleQueryError } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { authorizeHostedRequest } from "@/omh/auth-gate";
import { CreationPhaseError } from "@/omh/contracts-failure";
import { apiHono } from "./api";
import { apiErrorResponse } from "./api-error";

const statement = 'insert into "agentic_command_records" ("idempotency_key") values ($1)';
const parameter = "contract-key-that-must-stay-out-of-the-answer";
/** What drizzle raises for a query it built, around whatever the platform client raised. */
const failedQuery = (cause: Error) => new DrizzleQueryError(statement, [parameter], cause);

async function body(response: Response): Promise<unknown> {
	expect(response.headers.get("content-type")).toContain("application/json");
	return response.json();
}

/** The platform's error code is a diagnostic for the administrator who operates the app. */
const asAdministrator = (error: unknown) => apiErrorResponse(error, { administrator: true });

describe("unexpected API failures", () => {
	// Routes are added before the first request: Hono builds its matcher then.
	beforeAll(() => {
		apiHono.get("/__failure", () => {
			throw new CustomerRuntimeGatewayError("gateway_unavailable", null, true);
		});
		apiHono.post("/signing/:token/__failure", () => {
			throw new CustomerRuntimeGatewayError("paid_plan_required", 402, false);
		});
		apiHono.get("/final-documents/:token/__failure", () => {
			throw new CustomerRuntimeGatewayError("mail_reputation_suspended", 423, false);
		});
	});

	it("returns the stable platform code of a retryable runtime failure as JSON 503", async () => {
		const response = asAdministrator(
			new CustomerRuntimeGatewayError("gateway_timeout", null, true),
		);
		expect(response.status).toBe(503);
		expect(await body(response)).toEqual({
			error: {
				code: "PLATFORM_SERVICE_ERROR",
				message: "A platform service failed. Retry only if it is marked retryable.",
				reason: "gateway_timeout",
				retryable: true,
			},
		});
	});

	it("keeps a non-retryable runtime failure and database SQLSTATE without SQL or messages", async () => {
		const runtime = asAdministrator(new CustomerRuntimeGatewayError("unauthorized", 401, false));
		expect(runtime.status).toBe(500);
		expect(await body(runtime)).toMatchObject({
			error: { reason: "unauthorized", retryable: false },
		});
		const database = asAdministrator(new CustomerDatabaseError("40001"));
		expect(database.status).toBe(503);
		expect(await body(database)).toEqual({
			error: {
				code: "DATABASE_ERROR",
				message: "The database rejected the request.",
				reason: "40001",
				retryable: true,
			},
		});
	});

	it("answers JSON for unknown errors and keeps Hono's own HTTP exceptions", async () => {
		const unknown = asAdministrator(new TypeError("secret detail"));
		expect(unknown.status).toBe(500);
		const text = JSON.stringify(await body(unknown));
		expect(text).toContain("INTERNAL_ERROR");
		expect(text).not.toContain("secret detail");
		const exception = asAdministrator(new HTTPException(413, { message: "too large" }));
		expect(exception.status).toBe(413);
	});

	describe("a failure behind the query layer's wrapper", () => {
		it("answers a platform runtime failure with its code, never with the SQL or its parameters", async () => {
			const response = asAdministrator(
				failedQuery(new CustomerRuntimeError("database_unavailable", true)),
			);
			expect(response.status).toBe(503);
			const answer = await body(response);
			expect(answer).toEqual({
				error: {
					code: "PLATFORM_SERVICE_ERROR",
					message: "A platform service failed. Retry only if it is marked retryable.",
					reason: "database_unavailable",
					retryable: true,
				},
			});
			expect(JSON.stringify(answer)).not.toContain("agentic_command_records");
			expect(JSON.stringify(answer)).not.toContain(parameter);
		});

		it.each([
			["23505", 500, false],
			["40001", 503, true],
		])("answers a plain SQL error %s as DATABASE_ERROR JSON %i, without SQL text", async (sqlstate, status, retryable) => {
			const response = asAdministrator(failedQuery(new CustomerDatabaseError(sqlstate)));
			expect(response.status).toBe(status);
			const answer = await body(response);
			expect(answer).toEqual({
				error: {
					code: "DATABASE_ERROR",
					message: "The database rejected the request.",
					reason: sqlstate,
					retryable,
				},
			});
			expect(JSON.stringify(answer)).not.toContain("agentic_command_records");
			expect(JSON.stringify(answer)).not.toContain(parameter);
		});

		it("finds the platform code through nested wrappers and a creation step marker", async () => {
			const response = asAdministrator(
				new CreationPhaseError(
					"activation",
					failedQuery(failedQuery(new CustomerRuntimeGatewayError("gateway_timeout", null, true))),
				),
			);
			expect(response.status).toBe(503);
			await expect(body(response)).resolves.toMatchObject({
				error: { code: "PLATFORM_SERVICE_ERROR", reason: "gateway_timeout", retryable: true },
			});
		});

		it("keeps answering INTERNAL_ERROR for a bug behind the wrapper, without its text", async () => {
			const response = asAdministrator(failedQuery(new TypeError("secret detail")));
			expect(response.status).toBe(500);
			const text = JSON.stringify(await body(response));
			expect(text).toContain("INTERNAL_ERROR");
			expect(text).not.toContain("secret detail");
			expect(text).not.toContain("agentic_command_records");
			expect(text).not.toContain(parameter);
		});
	});

	it("applies to every route mounted below /api", async () => {
		// The hosted gate sets this header from the administrator it verified.
		const response = await apiHono.request("/api/__failure", {
			headers: { "x-internal-user-id": "owner@example.com" },
		});
		expect(response.status).toBe(503);
		expect(await body(response)).toMatchObject({
			error: { code: "PLATFORM_SERVICE_ERROR", reason: "gateway_unavailable", retryable: true },
		});
	});

	/**
	 * A refusal such as paid_plan_required, insufficient_organization_credits, project_budget_exceeded
	 * or mail_reputation_suspended names the sender's plan, credit, budget or reputation. A signer or
	 * the holder of a download link, who reaches the API without an administrator session, must not
	 * learn it: they get the same failure without the platform's code.
	 */
	describe("a caller who is not the administrator", () => {
		it.each([
			[
				new CustomerRuntimeGatewayError("paid_plan_required", 402, false),
				500,
				"PLATFORM_SERVICE_ERROR",
			],
			[
				new CustomerRuntimeGatewayError("mail_send_limit_exceeded", 429, true),
				503,
				"PLATFORM_SERVICE_ERROR",
			],
			[new CustomerDatabaseError("40001"), 503, "DATABASE_ERROR"],
		])("gets the failure without the platform's code: %s", async (error, status, code) => {
			const response = apiErrorResponse(error, { administrator: false });
			expect(response.status).toBe(status);
			const answer = (await body(response)) as { error: Record<string, unknown> };
			expect(answer.error).toEqual({
				code,
				message: expect.any(String),
				retryable: status === 503,
			});
			expect(JSON.stringify(answer)).not.toMatch(/paid_plan|limit_exceeded|40001/);
		});

		it("is not told the reason by a failing signer or download route either", async () => {
			for (const path of [
				"/api/signing/a-token/__failure",
				"/api/final-documents/a-token/__failure",
			]) {
				// The client claims to be the administrator: the gate removes the header on public routes.
				const forged = new Request(`https://sign.example.com${path}`, {
					method: path.includes("/signing/") ? "POST" : "GET",
					headers: { "x-internal-user-id": "owner@example.com" },
				});
				const gate = await authorizeHostedRequest(forged, {
					SIGN_ADMIN_EMAILS: "owner@example.com",
				});
				if ("response" in gate) throw new Error(`${path} should be public`);
				const response = await apiHono.fetch(gate.request, {} as Env);
				expect(response.status, path).toBe(500);
				const answer = (await body(response)) as { error: Record<string, unknown> };
				expect(answer.error, path).toEqual({
					code: "PLATFORM_SERVICE_ERROR",
					message: expect.any(String),
					retryable: false,
				});
			}
		});
	});
});
