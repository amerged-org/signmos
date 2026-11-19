import {
	auditEvents,
	envelopes,
	finalDocuments,
	idempotencyRecords,
	rateLimitRecords,
	senderVerificationEmailRecords,
	senderVerificationTokens,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	idempotencyTable: null as unknown,
	senderVerificationTokensTable: null as unknown,
	senderVerificationEmailRecordsTable: null as unknown,
	rateLimitRecordsTable: null as unknown,
	auditEventsTable: null as unknown,
	finalDocumentsTable: null as unknown,
	envelopes: [] as Array<Record<string, unknown>>,
	idempotencyRecords: [] as Array<Record<string, unknown>>,
	senderVerificationTokens: [] as Array<Record<string, unknown>>,
	senderVerificationEmailRecords: [] as Array<Record<string, unknown>>,
	rateLimitRecords: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	finalDocuments: [] as Array<Record<string, unknown>>,
}));

function selectRows(table: unknown): Array<Record<string, unknown>> {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.idempotencyTable) return state.idempotencyRecords;
	if (table === state.senderVerificationTokensTable) return state.senderVerificationTokens;
	if (table === state.senderVerificationEmailRecordsTable)
		return state.senderVerificationEmailRecords;
	if (table === state.rateLimitRecordsTable) return state.rateLimitRecords;
	if (table === state.auditEventsTable) return state.auditEvents;
	if (table === state.finalDocumentsTable) return state.finalDocuments;
	return [];
}

function insertRows(table: unknown, rows: Array<Record<string, unknown>>) {
	if (table === state.envelopesTable) return insertWithDefaults(state.envelopes, rows, "00000000");
	if (table === state.idempotencyTable) {
		return insertWithDefaults(state.idempotencyRecords, rows, "10000000");
	}
	if (table === state.senderVerificationTokensTable) {
		return insertWithDefaults(state.senderVerificationTokens, rows, "20000000", {
			verifiedAt: null,
		});
	}
	if (table === state.senderVerificationEmailRecordsTable) {
		return insertWithDefaults(state.senderVerificationEmailRecords, rows, "30000000", {
			sentAt: new Date("2026-05-21T09:00:00.000Z"),
		});
	}
	if (table === state.rateLimitRecordsTable) {
		return insertWithDefaults(state.rateLimitRecords, rows, "40000000");
	}
	if (table === state.auditEventsTable)
		return insertWithDefaults(state.auditEvents, rows, "50000000");
	return rows;
}

function insertWithDefaults(
	target: Array<Record<string, unknown>>,
	rows: Array<Record<string, unknown>>,
	prefix: string,
	extra: Record<string, unknown> = {},
) {
	const inserted = rows.map((row, index) => ({
		id: `${prefix}-0000-4000-8000-${String(target.length + index + 1).padStart(12, "0")}`,
		createdAt: new Date("2026-05-21T09:00:00.000Z"),
		updatedAt: new Date("2026-05-21T09:00:00.000Z"),
		...extra,
		...row,
	}));
	target.push(...inserted);
	return inserted;
}

function updateRows(table: unknown, value: Record<string, unknown>) {
	if (table === state.envelopesTable) {
		state.envelopes = state.envelopes.map((row) => ({ ...row, ...value }));
	}
	if (table === state.senderVerificationTokensTable) {
		state.senderVerificationTokens = state.senderVerificationTokens.map((row) => ({
			...row,
			...value,
		}));
	}
	if (table === state.rateLimitRecordsTable) {
		state.rateLimitRecords = state.rateLimitRecords.map((row) => ({ ...row, ...value }));
	}
	return [];
}

function resetState() {
	state.envelopesTable = envelopes;
	state.idempotencyTable = idempotencyRecords;
	state.senderVerificationTokensTable = senderVerificationTokens;
	state.senderVerificationEmailRecordsTable = senderVerificationEmailRecords;
	state.rateLimitRecordsTable = rateLimitRecords;
	state.auditEventsTable = auditEvents;
	state.finalDocumentsTable = finalDocuments;
	for (const key of [
		"envelopes",
		"idempotencyRecords",
		"senderVerificationTokens",
		"senderVerificationEmailRecords",
		"rateLimitRecords",
		"auditEvents",
		"finalDocuments",
	] as const) {
		state[key].length = 0;
	}
}

type TestSigningMode = "only_me" | "me_and_another_signer";

function seedAwaitingVerificationEnvelope(signingMode: TestSigningMode = "me_and_another_signer") {
	state.envelopes.push({
		id: "00000000-0000-4000-8000-000000000001",
		status: "awaiting_verification",
		signingMode,
		createdBy: "ada@example.com",
		createdAt: new Date("2026-05-21T09:00:00.000Z"),
		sentBy: null,
		sentAt: null,
	});
	state.senderVerificationTokens.push({
		id: "20000000-0000-4000-8000-000000000001",
		envelopeId: "00000000-0000-4000-8000-000000000001",
		name: "Ada Lovelace",
		email: "ada@example.com",
		token: "sender-token",
		status: "pending",
		expiresAt: new Date("2026-05-21T09:30:00.000Z"),
		verifiedAt: null,
		createdAt: new Date("2026-05-21T09:00:00.000Z"),
	});
}

vi.mock("@/db/setup", () => ({
	getDb: () => ({
		select: () => ({
			from: (table: unknown) => ({
				where: () => ({
					limit: async () => selectRows(table),
				}),
			}),
		}),
		insert: (table: unknown) => ({
			values: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => ({
				returning: async () => insertRows(table, Array.isArray(rows) ? rows : [rows]),
			}),
		}),
		update: (table: unknown) => ({
			set: (value: Record<string, unknown>) => ({
				where: async () => updateRows(table, value),
			}),
		}),
	}),
}));

describe("sender start API", () => {
	beforeEach(resetState);

	it("starts a no-account sender envelope without returning a normal verification fallback link", async () => {
		// Assumptions for issue #23:
		// - POST /api/envelopes/sender-start is the public no-account start boundary.
		// - A test Turnstile bypass is explicit and only active through the route environment.
		// - Start creates awaiting_verification state; the magic link later moves it to draft.
		// - Verification fallback links stay out of the normal response body.
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Turnstile network should not be called"));
		const response = await apiHono.request(
			"/api/envelopes/sender-start",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "sender-start-1",
					"cf-connecting-ip": "203.0.113.10",
				},
				body: JSON.stringify({
					signingMode: "only_me",
					name: "Ada Lovelace",
					email: "ADA@EXAMPLE.COM",
					turnstileToken: "test-pass",
				}),
			},
			{ TURNSTILE_TEST_BYPASS: "true" },
		);

		expect(response.status).toBe(201);
		const responseJson = await response.json();
		expect(responseJson).toEqual({
			data: {
				envelopeId: expect.any(String),
				status: "awaiting_verification",
				signingMode: "only_me",
				sender: {
					name: "Ada Lovelace",
					email: "ada@example.com",
				},
				allowedActions: ["verify_sender_email"],
				verification: {
					email: "ada@example.com",
					expiresAt: expect.any(String),
				},
			},
		});
		expect(JSON.stringify(responseJson)).not.toContain("/sender-verifications/");
		expect(state.envelopes).toEqual([
			expect.objectContaining({
				status: "awaiting_verification",
				signingMode: "only_me",
				createdBy: "ada@example.com",
			}),
		]);
		expect(state.senderVerificationEmailRecords).toEqual([
			expect.objectContaining({
				email: "ada@example.com",
				kind: "sender_verification",
				fallbackUrl: expect.stringContaining("/sender-verifications/"),
			}),
		]);
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "sender.start.created" }),
				expect.objectContaining({ eventType: "sender.verification.sent" }),
			]),
		);
		expect(fetchMock).not.toHaveBeenCalled();
		fetchMock.mockRestore();
	});

	it("exposes the sender verification fallback URL only on an explicit developer debug request", async () => {
		// Assumptions for issue #23:
		// - The ordinary JSON response is the normal UI surface and must not expose raw links.
		// - A developer/test debug surface requires both a request header and non-production env.
		// - The persisted email/send record remains the source for fallback recovery outside UI.
		const normal = await apiHono.request(
			"/api/envelopes/sender-start",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "sender-start-normal-no-debug",
					"cf-connecting-ip": "203.0.113.10",
				},
				body: JSON.stringify({
					name: "Ada Lovelace",
					email: "ada@example.com",
					turnstileToken: "test-pass",
				}),
			},
			{ TURNSTILE_TEST_BYPASS: "true" },
		);

		expect(normal.status).toBe(201);
		expect(JSON.stringify(await normal.json())).not.toContain("/sender-verifications/");

		const debug = await apiHono.request(
			"/api/envelopes/sender-start",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "sender-start-debug-link",
					"cf-connecting-ip": "203.0.113.11",
					"x-signmos-debug": "sender-verification-link",
				},
				body: JSON.stringify({
					name: "Grace Hopper",
					email: "grace@example.com",
					turnstileToken: "test-pass",
				}),
			},
			{ CLOUDFLARE_ENV: "dev", TURNSTILE_TEST_BYPASS: "true" },
		);

		expect(debug.status).toBe(201);
		const debugBody = (await debug.json()) as {
			data: {
				verification: Record<string, unknown>;
			};
			debug: {
				senderVerificationUrl: string;
			};
		};
		expect(debugBody).toEqual({
			data: expect.any(Object),
			debug: {
				senderVerificationUrl: expect.stringContaining("/sender-verifications/"),
			},
		});
		expect(debugBody.data.verification).toEqual({
			email: "grace@example.com",
			expiresAt: expect.any(String),
		});

		const productionDebug = await apiHono.request(
			"/api/envelopes/sender-start",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "sender-start-prod-debug-link",
					"cf-connecting-ip": "203.0.113.12",
					"x-signmos-debug": "sender-verification-link",
				},
				body: JSON.stringify({
					name: "Katherine Johnson",
					email: "katherine@example.com",
					turnstileToken: "test-pass",
				}),
			},
			{ CLOUDFLARE_ENV: "production", TURNSTILE_TEST_BYPASS: "true" },
		);

		expect(productionDebug.status).toBe(403);
		expect(JSON.stringify(await productionDebug.json())).not.toContain("/sender-verifications/");
	});

	it("delivers sender verification emails through Resend when configured", async () => {
		// Assumptions for sender verification delivery RED:
		// - POST /api/envelopes/sender-start remains the public sender start boundary.
		// - The sender receives a magic verification URL through Resend when config is complete.
		// - The normal response hides fallback URLs while email delivery still receives one.
		// - Failed provider delivery must not silently look successful to the caller.
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "resend-sender-email-1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const response = await apiHono.request(
			"/api/envelopes/sender-start",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "sender-start-resend-1",
					"cf-connecting-ip": "203.0.113.10",
				},
				body: JSON.stringify({
					name: "Ada Lovelace",
					email: "ada@example.com",
					turnstileToken: "test-pass",
				}),
			},
			{
				TURNSTILE_TEST_BYPASS: "true",
				APP_BASE_URL: "https://signmos.example",
				RESEND_API_KEY: "re_test",
				RESEND_FROM_EMAIL: "Signmos <sign@signmos.example>",
				RESEND_REPLY_TO_EMAIL: "support@signmos.example",
			},
		);

		expect(response.status).toBe(201);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.resend.com/emails",
			expect.objectContaining({
				method: "POST",
				headers: {
					authorization: "Bearer re_test",
					"content-type": "application/json",
				},
				body: expect.any(String),
			}),
		);
		const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
		expect(requestBody).toEqual(
			expect.objectContaining({
				from: "Signmos <sign@signmos.example>",
				reply_to: "support@signmos.example",
				to: ["ada@example.com"],
				subject: "E-Mail-Adresse bestätigen · amerged Sign",
			}),
		);
		expect(requestBody.html).toContain("https://signmos.example/sender-verifications/");

		fetchMock.mockRestore();
	});

	it("returns provider details for sender email delivery failures outside production", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "The auditmos.com domain is not verified" }), {
				status: 403,
				headers: { "content-type": "application/json" },
			}),
		);

		const response = await apiHono.request(
			"/api/envelopes/sender-start",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "sender-start-resend-fails-1",
					"cf-connecting-ip": "203.0.113.10",
				},
				body: JSON.stringify({
					name: "Ada Lovelace",
					email: "ada@example.com",
					turnstileToken: "test-pass",
				}),
			},
			{
				CLOUDFLARE_ENV: "dev",
				TURNSTILE_TEST_BYPASS: "true",
				APP_BASE_URL: "https://signmos.example",
				RESEND_API_KEY: "re_test",
				RESEND_FROM_EMAIL: "Signmos <sign@signmos.example>",
				RESEND_REPLY_TO_EMAIL: "support@signmos.example",
			},
		);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "EMAIL_DELIVERY_FAILED",
				message: "Email provider rejected the message",
				providerStatus: 403,
				providerMessage: "The auditmos.com domain is not verified",
			},
		});

		fetchMock.mockRestore();
	});

	it("rejects missing or failed Turnstile and rate-limited IP or email attempts", async () => {
		const missingTurnstile = await apiHono.request("/api/envelopes/sender-start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Ada Lovelace", email: "ada@example.com" }),
		});

		expect(missingTurnstile.status).toBe(400);
		await expect(missingTurnstile.json()).resolves.toEqual({
			error: {
				code: "INVALID_SENDER_START",
				message: "Sender name, email, and Turnstile token are required",
				fields: ["name", "email", "turnstileToken"],
			},
		});
		expect(state.envelopes).toHaveLength(0);
		expect(state.senderVerificationTokens).toHaveLength(0);
		expect(state.senderVerificationEmailRecords).toHaveLength(0);

		const failedTurnstile = await apiHono.request("/api/envelopes/sender-start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Ada Lovelace",
				email: "ada@example.com",
				turnstileToken: "invalid",
			}),
		});

		expect(failedTurnstile.status).toBe(403);
		await expect(failedTurnstile.json()).resolves.toEqual({
			error: {
				code: "TURNSTILE_FAILED",
				message: "Turnstile verification failed",
			},
		});
		expect(state.envelopes).toHaveLength(0);
		expect(state.senderVerificationTokens).toHaveLength(0);
		expect(state.senderVerificationEmailRecords).toHaveLength(0);

		state.rateLimitRecords.push({
			id: "40000000-0000-4000-8000-000000000001",
			key: "ip:203.0.113.10",
			operation: "sender-start",
			attempts: 5,
			resetAt: new Date("2026-05-21T09:10:00.000Z"),
			createdAt: new Date("2026-05-21T09:00:00.000Z"),
			updatedAt: new Date("2026-05-21T09:00:00.000Z"),
		});
		const rateLimitedIp = await apiHono.request(
			"/api/envelopes/sender-start",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": "203.0.113.10",
					"x-now": "2026-05-21T09:01:00.000Z",
				},
				body: JSON.stringify({
					name: "Ada Lovelace",
					email: "ada@example.com",
					turnstileToken: "test-pass",
				}),
			},
			{ TURNSTILE_TEST_BYPASS: "true" },
		);

		expect(rateLimitedIp.status).toBe(429);
		await expect(rateLimitedIp.json()).resolves.toEqual({
			error: {
				code: "RATE_LIMITED",
				message: "Too many sender start attempts",
				scope: "ip",
				resetAt: "2026-05-21T09:10:00.000Z",
			},
		});

		resetState();
		state.rateLimitRecords.push({
			id: "40000000-0000-4000-8000-000000000002",
			key: "email:ada@example.com",
			operation: "sender-start",
			attempts: 5,
			resetAt: new Date("2026-05-21T09:10:00.000Z"),
			createdAt: new Date("2026-05-21T09:00:00.000Z"),
			updatedAt: new Date("2026-05-21T09:00:00.000Z"),
		});
		const rateLimitedEmail = await apiHono.request(
			"/api/envelopes/sender-start",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": "198.51.100.10",
					"x-now": "2026-05-21T09:01:00.000Z",
				},
				body: JSON.stringify({
					name: "Ada Lovelace",
					email: "ADA@EXAMPLE.COM",
					turnstileToken: "test-pass",
				}),
			},
			{ TURNSTILE_TEST_BYPASS: "true" },
		);

		expect(rateLimitedEmail.status).toBe(429);
		await expect(rateLimitedEmail.json()).resolves.toMatchObject({
			error: {
				code: "RATE_LIMITED",
				scope: "email",
			},
		});
	});

	it("verifies valid sender magic links and returns stable errors for invalid or expired links", async () => {
		seedAwaitingVerificationEnvelope("only_me");

		const verified = await apiHono.request("/api/envelopes/sender-verifications/sender-token", {
			headers: { "x-now": "2026-05-21T09:05:00.000Z" },
		});

		expect(verified.status).toBe(200);
		await expect(verified.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				status: "draft",
				signingMode: "only_me",
				senderSessionToken: "sender-token",
				sender: {
					name: "Ada Lovelace",
					email: "ada@example.com",
				},
				allowedActions: ["upload_source_pdf", "add_recipients", "add_fields", "send"],
				verifiedAt: "2026-05-21T09:05:00.000Z",
			},
		});
		expect(state.envelopes[0]?.status).toBe("draft");
		expect(state.senderVerificationTokens[0]?.status).toBe("verified");
		expect(state.auditEvents).toEqual([
			expect.objectContaining({
				eventType: "sender.verified",
				message: "ada@example.com",
			}),
		]);

		const reusedSession = await apiHono.request(
			"/api/envelopes/sender-verifications/sender-token",
			{
				headers: { "x-now": "2026-05-21T09:31:00.000Z" },
			},
		);
		expect(reusedSession.status).toBe(200);
		await expect(reusedSession.json()).resolves.toMatchObject({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				signingMode: "only_me",
				senderSessionToken: "sender-token",
				sender: {
					name: "Ada Lovelace",
					email: "ada@example.com",
				},
			},
		});

		const senderSession = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/sender-session",
			{
				headers: {
					"x-sender-session-token": "sender-token",
					"x-now": "2026-05-21T09:31:00.000Z",
				},
			},
		);
		expect(senderSession.status).toBe(200);
		await expect(senderSession.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				sender: {
					name: "Ada Lovelace",
					email: "ada@example.com",
				},
			},
		});

		const invalid = await apiHono.request("/api/envelopes/sender-verifications/not-found");
		expect(invalid.status).toBe(404);
		await expect(invalid.json()).resolves.toEqual({
			error: {
				code: "SENDER_VERIFICATION_NOT_FOUND",
				message: "Sender verification token was not found",
			},
		});

		resetState();
		seedAwaitingVerificationEnvelope();
		const expired = await apiHono.request("/api/envelopes/sender-verifications/sender-token", {
			headers: { "x-now": "2026-05-21T09:31:00.000Z" },
		});

		expect(expired.status).toBe(410);
		await expect(expired.json()).resolves.toEqual({
			error: {
				code: "EXPIRED_SENDER_VERIFICATION",
				message: "Sender verification token has expired",
			},
		});
		expect(state.envelopes[0]?.status).toBe("awaiting_verification");
	});

	it("blocks single-signer upload, signature, and history access before email verification", async () => {
		seedAwaitingVerificationEnvelope("only_me");

		const sourcePdf = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				headers: {
					"x-sender-session-token": "sender-token",
					"x-now": "2026-05-21T09:05:00.000Z",
				},
			},
		);
		expect(sourcePdf.status).toBe(401);
		await expect(sourcePdf.json()).resolves.toEqual({
			error: {
				code: "UNAUTHORIZED",
				message: "Missing x-internal-user-id header",
			},
		});

		const signature = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/signature-profiles/selected",
			{
				headers: {
					"x-sender-session-token": "sender-token",
					"x-now": "2026-05-21T09:05:00.000Z",
				},
			},
		);
		expect(signature.status).toBe(401);
		await expect(signature.json()).resolves.toEqual({
			error: {
				code: "UNAUTHORIZED",
				message: "Missing x-internal-user-id header",
			},
		});

		const history = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/history",
			{
				headers: {
					"x-sender-session-token": "sender-token",
					"x-now": "2026-05-21T09:05:00.000Z",
				},
			},
		);
		expect(history.status).toBe(403);
		await expect(history.json()).resolves.toEqual({
			error: {
				code: "HISTORY_FORBIDDEN",
				message: "Verified sender access is required before viewing document history",
			},
		});
	});

	it("redirects browser navigation from the sender verification API to the UI route", async () => {
		const response = await apiHono.request("/api/envelopes/sender-verifications/sender-token", {
			headers: { accept: "text/html,application/xhtml+xml" },
		});

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/sender-verifications/sender-token");
	});

	it("exposes awaiting-verification and draft status with allowed next actions", async () => {
		seedAwaitingVerificationEnvelope();

		const awaiting = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/status",
		);

		expect(awaiting.status).toBe(200);
		await expect(awaiting.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				status: "awaiting_verification",
				finalPdfAvailable: false,
				allowedActions: ["verify_sender_email"],
				pendingRecipients: [],
			},
		});

		state.envelopes[0] = { ...state.envelopes[0], status: "draft" };
		const draft = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/status",
		);

		expect(draft.status).toBe(200);
		await expect(draft.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				status: "draft",
				finalPdfAvailable: false,
				allowedActions: ["upload_source_pdf", "add_recipients", "add_fields", "send"],
				pendingRecipients: [],
			},
		});
	});

	it("reuses idempotent sender starts without duplicating envelopes or verification sends", async () => {
		const request = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "sender-start-1",
				"cf-connecting-ip": "203.0.113.10",
			},
			body: JSON.stringify({
				signingMode: "only_me",
				name: "Ada Lovelace",
				email: "ada@example.com",
				turnstileToken: "test-pass",
			}),
		};

		const first = await apiHono.request("/api/envelopes/sender-start", request, {
			TURNSTILE_TEST_BYPASS: "true",
		});
		const second = await apiHono.request("/api/envelopes/sender-start", request, {
			TURNSTILE_TEST_BYPASS: "true",
		});

		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		const firstBody = (await first.clone().json()) as { data: { signingMode: string } };
		expect(await second.json()).toEqual(firstBody);
		expect(firstBody.data.signingMode).toBe("only_me");
		expect(state.envelopes).toHaveLength(1);
		expect(state.senderVerificationEmailRecords).toHaveLength(1);
		expect(state.senderVerificationTokens).toHaveLength(1);
	});
});
