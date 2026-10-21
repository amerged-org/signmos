import { agenticApiTokens, agenticSecurityEvents } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { envelopes } from "@/db/envelope";
import {
	hashHistoryCredential,
	historyAccessLinks,
	historySecurityEvents,
	historySessions,
} from "@/db/history-access";
import {
	adminAuthConfigured,
	createAdminCsrfToken,
	isAllowedAdmin,
	resolveAdminRequest,
} from "./auth";
import { authorizeHostedRequest } from "./auth-gate";
import { redeemAdminLogin } from "./auth-login";
import authEndpoint from "./auth-routes";

type StoredRow = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: new Map<unknown, StoredRow[]>() }));

function valuesIn(condition: unknown): string[] {
	if (!condition || typeof condition !== "object") return [];
	if ("value" in condition && typeof condition.value === "string") return [condition.value];
	if (!("queryChunks" in condition) || !Array.isArray(condition.queryChunks)) return [];
	return condition.queryChunks.flatMap(valuesIn);
}

function matchingRows(table: unknown, condition?: unknown): StoredRow[] {
	const values = valuesIn(condition);
	return (state.tables.get(table) ?? []).filter((row) =>
		values.every((value) => Object.values(row).includes(value)),
	);
}

vi.mock("@/db/setup", () => ({
	getDb: () => ({
		select: () => ({
			from: (table: unknown) => ({
				where: (condition: unknown) => {
					const rows = matchingRows(table, condition);
					return Object.assign(Promise.resolve(rows), {
						limit: async (count: number) => rows.slice(0, count),
					});
				},
			}),
		}),
		update: (table: unknown) => ({
			set: (values: StoredRow) => ({
				where: (condition: unknown) => ({
					returning: async () => {
						const rows = matchingRows(table, condition);
						for (const row of rows) Object.assign(row, values);
						return rows;
					},
				}),
			}),
		}),
		insert: (table: unknown) => ({
			values: (values: StoredRow) => ({
				returning: async () => {
					const row = { id: crypto.randomUUID(), createdAt: new Date(), ...values };
					const rows = state.tables.get(table) ?? [];
					rows.push(row);
					state.tables.set(table, rows);
					return [row];
				},
			}),
		}),
	}),
}));

describe("amerged Sign administrator boundary", () => {
	const env = { SIGN_ADMIN_EMAILS: " Owner@amerged.com , other@amerged.com" };
	const rawSession = "secure-random-history-session";
	const rawToken = "signmos_valid_long_owner_bearer_token";
	const envelopeId = "a0000000-0000-4000-8000-000000000001";

	beforeEach(async () => {
		state.tables = new Map<unknown, StoredRow[]>([
			[
				historySessions,
				[
					{
						id: "session-id",
						linkId: "link-id",
						email: "owner@amerged.com",
						sessionHash: await hashHistoryCredential(rawSession),
						status: "active",
						expiresAt: new Date(Date.now() + 3_600_000),
					},
				],
			],
			[historyAccessLinks, []],
			[historySecurityEvents, []],
			[
				agenticApiTokens,
				[
					{
						id: "token-id",
						email: "owner@amerged.com",
						name: "Integration",
						tokenHash: await hashAgenticCredential(rawToken),
						tokenHint: "signmos_…oken",
						status: "active",
						createdAt: new Date(),
					},
				],
			],
			[agenticSecurityEvents, []],
			[
				envelopes,
				[
					{
						id: envelopeId,
						createdBy: "owner@amerged.com",
						status: "draft",
						createdAt: new Date(),
					},
				],
			],
		]);
	});

	function request(path: string, init: RequestInit = {}): Request {
		return new Request(`https://sign.amerged.com${path}`, init);
	}

	it("fails closed without configuration and denies unauthenticated or spoofed headers", async () => {
		expect(adminAuthConfigured({})).toBe(false);
		expect(isAllowedAdmin(" owner@AMERGED.COM ", env)).toBe(true);
		const untrustedHeaders: Record<string, string>[] = [
			{},
			{ "x-internal-user-id": "owner@amerged.com" },
			{ authorization: `Bearer ${rawToken}` },
		];
		for (const headers of untrustedHeaders) {
			const auth = await resolveAdminRequest(request("/api/envelopes/", { headers }), env);
			expect(auth.ok).toBe(false);
			if (!auth.ok) expect(auth.response.status).toBe(403);
		}
		const auth = await resolveAdminRequest(request("/api/contracts"), {});
		expect(auth.ok).toBe(false);
		if (!auth.ok) expect(auth.response.status).toBe(503);
	});

	it("accepts only current allowlisted sessions and active allowlisted API tokens", async () => {
		const cookie = `signmos_history_session=${rawSession}`;
		expect(
			(await resolveAdminRequest(request("/api/contracts", { headers: { cookie } }), env)).ok,
		).toBe(true);
		expect(
			(
				await resolveAdminRequest(
					request("/api/contracts", { headers: { authorization: `Bearer ${rawToken}` } }),
					env,
					{ allowBearer: true },
				)
			).ok,
		).toBe(true);
		const session = state.tables.get(historySessions)?.[0];
		if (!session) throw new Error("missing session fixture");
		session.email = "outsider@example.com";
		expect(
			(await resolveAdminRequest(request("/api/contracts", { headers: { cookie } }), env)).ok,
		).toBe(false);
		session.email = "owner@amerged.com";
		session.status = "revoked";
		expect(
			(await resolveAdminRequest(request("/api/contracts", { headers: { cookie } }), env)).ok,
		).toBe(false);
		const token = state.tables.get(agenticApiTokens)?.[0];
		if (!token) throw new Error("missing token fixture");
		token.email = "outsider@example.com";
		expect(
			(
				await resolveAdminRequest(
					request("/api/contracts", { headers: { authorization: `Bearer ${rawToken}` } }),
					env,
					{ allowBearer: true },
				)
			).ok,
		).toBe(false);
	});

	it("binds browser mutations to same-origin and a token derived from the active session", async () => {
		const csrfToken = await createAdminCsrfToken(rawSession);
		const invalidCsrfHeaders: Record<string, string>[] = [
			{},
			{ origin: "https://evil.example", "x-csrf-token": csrfToken },
			{ origin: "https://sign.amerged.com", "x-csrf-token": "wrong" },
		];
		for (const headers of invalidCsrfHeaders) {
			expect(
				(
					await resolveAdminRequest(
						request("/api/contracts", {
							method: "POST",
							headers: { cookie: `signmos_history_session=${rawSession}`, ...headers },
						}),
						env,
					)
				).ok,
			).toBe(false);
		}
		expect(
			(
				await resolveAdminRequest(
					request("/api/contracts", {
						method: "POST",
						headers: {
							cookie: `signmos_history_session=${rawSession}`,
							origin: "https://sign.amerged.com",
							"x-csrf-token": csrfToken,
						},
					}),
					env,
				)
			).ok,
		).toBe(true);
	});

	it("gates legacy creator endpoints by owner and sanitizes internal and clock headers", async () => {
		const headers = {
			cookie: `signmos_history_session=${rawSession}`,
			"x-internal-user-id": "other@amerged.com",
			"x-now": "2000-01-01",
			"x-signmos-debug": "credentials",
		};
		const allowed = await authorizeHostedRequest(
			request(`/api/envelopes/${envelopeId}/fields`, { headers }),
			env,
		);
		expect("request" in allowed).toBe(true);
		if ("request" in allowed) {
			expect(allowed.request.headers.get("x-internal-user-id")).toBe("owner@amerged.com");
			expect(allowed.request.headers.has("x-now")).toBe(false);
		}
		const envelope = state.tables.get(envelopes)?.[0];
		if (!envelope) throw new Error("missing contract fixture");
		envelope.createdBy = "other@amerged.com";
		const denied = await authorizeHostedRequest(
			request(`/api/envelopes/${envelopeId}/fields`, { headers }),
			env,
		);
		expect("response" in denied && denied.response.status).toBe(404);
		const encoded = await authorizeHostedRequest(
			request(`/api/envelopes/%61${envelopeId.slice(1)}/fields`, { headers }),
			env,
		);
		expect("response" in encoded && encoded.response.status).toBe(404);
		const page = await authorizeHostedRequest(request("/"), env);
		expect("response" in page && page.response.headers.get("location")).toBe("/login");
		const recipient = await authorizeHostedRequest(
			request("/api/signing/recipient-secret", { headers }),
			env,
		);
		expect("request" in recipient && recipient.request.headers.has("x-now")).toBe(false);
	});

	it("rejects arbitrary email-link identity and disables every legacy login issuance path", async () => {
		const credential = "one-time-credential-that-belongs-to-outsider";
		state.tables.set(historyAccessLinks, [
			{
				id: "outsider-link",
				email: "outsider@example.com",
				credentialHash: await hashHistoryCredential(credential),
				status: "active",
				expiresAt: new Date(Date.now() + 600_000),
			},
		]);
		expect(await redeemAdminLogin({ credential, env, requestIp: "127.0.0.1" })).toEqual({
			status: "unknown",
		});
		for (const path of [
			"/api/agentic/access-requests",
			"/api/history/access-requests",
			"/api/history/access-links/token/redeem",
			"/api/envelopes/sender-start",
		]) {
			const result = await authorizeHostedRequest(request(path, { method: "POST" }), env);
			expect("response" in result && result.response.status).toBe(404);
		}
	});

	it("returns safe session metadata and revokes logout sessions", async () => {
		const context = env as Env;
		const sessionResponse = await authEndpoint.request(
			request("/session", { headers: { cookie: `signmos_history_session=${rawSession}` } }),
			undefined,
			context,
		);
		const body = await sessionResponse.json();
		expect(body).toMatchObject({ data: { authenticated: true, email: "owner@amerged.com" } });
		expect(JSON.stringify(body)).not.toContain(rawSession);
		const csrfToken = await createAdminCsrfToken(rawSession);
		const loggedOut = await authEndpoint.request(
			request("/logout", {
				method: "POST",
				headers: {
					cookie: `signmos_history_session=${rawSession}`,
					origin: "https://sign.amerged.com",
					"x-csrf-token": csrfToken,
				},
			}),
			undefined,
			context,
		);
		expect(loggedOut.status).toBe(204);
		expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0");
		expect(state.tables.get(historySessions)?.[0]?.status).toBe("revoked");
	});

	it("redeems an allowlisted login once into a Secure HttpOnly host-only cookie", async () => {
		const credential = "single-use-admin-login-credential-that-is-random";
		state.tables.set(historyAccessLinks, [
			{
				id: "admin-login-link",
				email: "owner@amerged.com",
				credentialHash: await hashHistoryCredential(credential),
				status: "active",
				expiresAt: new Date(Date.now() + 600_000),
			},
		]);
		const redeem = () =>
			authEndpoint.request(
				request("/redeem-login", {
					method: "POST",
					headers: { origin: "https://sign.amerged.com", "content-type": "application/json" },
					body: JSON.stringify({ credential }),
				}),
				undefined,
				env as Env,
			);
		const response = await redeem();
		expect(response.status).toBe(201);
		const cookie = response.headers.get("set-cookie");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
		expect(cookie).not.toContain("Domain=");
		expect(JSON.stringify(await response.json())).not.toContain(credential);
		expect((await redeem()).status).toBe(410);
	});
});
