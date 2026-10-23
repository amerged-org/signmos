import { apiHono } from "@/hono/api";
import { useCreationHarness } from "./contracts-create-harness";
import { ContractError } from "./contracts-schema";

describe("bounded contract creation through private OMH adapters", () => {
	const creation = useCreationHarness();

	it("sends a maximum-field contract within ten physical subrequests including authentication, files, mail and receipt", async () => {
		creation.input.fields = Array.from({ length: 20 }, (_, index) => ({
			type: index === 0 ? "signature" : "date",
			page: 1,
			x: 72,
			y: 200,
			width: 180,
			height: 32,
		}));
		for (const mode of ["bearer", "browser"] as const) {
			creation.browser = mode === "browser";
			creation.physicalCalls = 0;
			creation.queries = [];
			creation.batches = [];
			const response = await creation.create();
			expect(response.status, mode).toBe(201);
			expect(creation.physicalCalls).toBeLessThanOrEqual(10);
			expect(creation.queries).toHaveLength(4);
			expect(creation.batches).toHaveLength(2);
			expect(
				creation.batches[0]?.some((query) => query.text.includes('"envelope_artifact_versions"')),
			).toBe(true);
			expect(creation.deliveredKey).toMatch(/^sign\.[a-f0-9]{64}$/);
			for (const batch of creation.batches) {
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
					title: creation.input.title,
					status: "sent",
					recipients: [{ email: "ada@example.com", status: "sent" }],
				},
			});
			const receipt = creation.batches[1]?.find((query) =>
				query.text.startsWith('update "agentic_command_records"'),
			);
			expect(receipt?.values).toContain(JSON.stringify(body));
		}
	});

	it("leaves the durable draft inactive when upload or mail confirmation is uncertain", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		for (const failure of ["storage", "mail"] as const) {
			creation.batches = [];
			creation.queries = [];
			creation.physicalCalls = 0;
			creation.deliveredKey = null;
			creation.storagePending = failure === "storage";
			creation.mailUncertain = failure === "mail";
			// An upload that is still pending leaves the command pending for the operator; an
			// uncertain mail is answered and recorded, so its key replays instead of staying "running".
			const response = await creation.create();
			expect(response.status).toBe(failure === "storage" ? 500 : 503);
			if (failure === "mail") {
				const body = (await response.json()) as { error: Record<string, unknown> };
				expect(body).toMatchObject({ error: { code: "EMAIL_DELIVERY_UNCERTAIN" } });
				// No platform call raised it, so there is no platform code to report.
				expect(body.error).not.toHaveProperty("reason");
			}
			expect(creation.batches).toHaveLength(1);
			expect(
				creation.batches[0]?.some(
					(query) =>
						query.text.startsWith('update "agentic_command_records"') &&
						query.text.includes('"document_id"'),
				),
			).toBe(true);
			expect(creation.deliveredKey === null).toBe(failure === "storage");
			expect(creation.physicalCalls).toBeLessThanOrEqual(10);
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
		creation.browser = mode === "browser";
		creation.mailRefusal = { status, code };
		const response = await creation.create();
		const body = await response.json();
		expect(response.status).toBe(httpStatus);
		expect(body).toMatchObject({ error: { code: apiCode, reason } });
		expect(creation.physicalCalls).toBeLessThanOrEqual(10);
		// The draft stays inactive and the command is completed with this exact answer.
		expect(creation.batches).toHaveLength(1);
		const receipt = creation.queries.find(
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
				creation.transactionThrows = 1;
			},
			reason: "database_unavailable",
			says: [/did not confirm saving the draft/, /nothing was uploaded/, /no invitation was sent/],
			doesNotSay: /may or may not have been delivered/,
			mailReached: false,
		},
		{
			phase: "storage",
			fail: () => {
				creation.storageDown = true;
			},
			reason: "gateway_unavailable",
			says: [/file storage did not confirm the PDF upload/, /no invitation was sent/],
			doesNotSay: /may or may not have been delivered/,
			mailReached: false,
		},
		{
			phase: "mail",
			fail: () => {
				creation.mailRefusal = { status: 503, code: "mail_gateway_unavailable" };
			},
			reason: "gateway_unavailable",
			says: [/may or may not have been delivered/, /signing link stays inactive/],
			doesNotSay: /link may not work/,
			mailReached: true,
		},
		{
			phase: "activation",
			fail: () => {
				creation.transactionThrows = 2;
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
		const response = await creation.create();
		const body = (await response.json()) as {
			error: { code: string; message: string; reason?: string };
		};
		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({ code: "PLATFORM_SERVICE_UNAVAILABLE", reason });
		for (const pattern of says) expect(body.error.message).toMatch(pattern);
		expect(body.error.message).not.toMatch(doesNotSay);
		expect(JSON.stringify(body)).not.toContain("Too many subrequests");
		// The answer is recorded for the original key, exactly as sent.
		const receipt = creation.queries.find(
			(query) =>
				query.text.startsWith('update "agentic_command_records"') &&
				query.values.includes(JSON.stringify(body)),
		);
		expect(receipt?.values).toContain("completed");
		// Only the mail and activation steps come after the request reached the mail gateway.
		expect(creation.deliveredKey === null).toBe(!mailReached);
		// Activation is the tenth platform call, so recording its failure is an eleventh: under a
		// hosted limit of ten that write is refused too, and the caller then gets the unrecorded
		// PLATFORM_SERVICE_ERROR instead of this answer.
		expect(creation.physicalCalls).toBeLessThanOrEqual(phase === "activation" ? 11 : 10);
	});

	it("records a contract error that a step raises under its own code and status", async () => {
		const put = async () => {
			throw new ContractError("SOURCE_PDF_TOO_LARGE", "Too large", 413);
		};
		creation.env = { ...creation.env, DOCUMENTS_BUCKET: { put } as unknown as R2Bucket };
		const response = await creation.create();
		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toEqual({
			error: { code: "SOURCE_PDF_TOO_LARGE", message: "Too large" },
		});
	});

	it("answers a failure it cannot record as the platform's own error, with its reason", async () => {
		// A call limit makes every later call fail, including the write that records the failure.
		creation.transactionThrows = 2;
		creation.recordingDown = true;
		const response = await creation.create(apiHono);
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
		expect(creation.deliveredKey).toMatch(/^sign\./);
	});

	it("hands the platform's own error, not the step marker, to the API error handler", async () => {
		creation.commitRejected = true;
		const response = await creation.create(apiHono);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "DATABASE_ERROR", reason: "40001", retryable: true },
		});
	});

	it("cannot report success when the final atomic activation and receipt transaction fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		creation.commitRejected = true;
		expect((await creation.create()).status).toBe(500);
		expect(creation.batches).toHaveLength(2);
		expect(creation.physicalCalls).toBeLessThanOrEqual(10);
		expect(creation.deliveredKey).toMatch(/^sign\./);
	});
});
