import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { getTableColumns } from "drizzle-orm";
import type { Context } from "hono";
import { hashHistoryCredential } from "@/db/history-access";
import { historySessions } from "@/db/history-access/table";
import { getDb } from "@/db/setup";
import { apiHono } from "@/hono/api";
import { serveHostedRequest } from "./hosted-request";

const origin = "https://sign.example.com";
const database: CustomerDatabaseBinding = {
	query: vi.fn(async () => ({ command: "SELECT", rows: [], rowCount: 0 })),
	transaction: vi.fn(async () => []),
};

function bindings(overrides: Partial<Env> = {}): Env {
	return {
		SIGN_ADMIN_EMAILS: "owner@example.com",
		OHMYHOST_DATABASE: database,
		...overrides,
	} as Env;
}
function serve(path: string, env: Env = bindings(), init: RequestInit = {}) {
	const next = vi.fn(async () => "app-response");
	const result = serveHostedRequest(new Request(`${origin}${path}`, init), env, next);
	return { next, result };
}

const sessionSecret = "browser-session-fixture";
const trustHeaders = ["x-now", "x-internal-user-id", "x-signmos-debug", "x-sender-session-token"];
/** A client that forges everything the API trusts: the clock, the identity, debug and sender token. */
const forgedHeaders = {
	"x-now": "2099-01-01T00:00:00Z",
	"x-internal-user-id": "attacker@example.com",
	"x-signmos-debug": "sender-verification-link",
	"x-sender-session-token": "forged-sender-session",
};

/** Bindings whose database knows one active administrator session, the way the hosted gate reads it. */
async function signedInBindings(overrides: Partial<Env> = {}): Promise<Env> {
	const row: Record<string, unknown> = {
		id: "a0000000-0000-4000-8000-000000000002",
		email: "owner@example.com",
		session_hash: await hashHistoryCredential(sessionSecret),
		status: "active",
		expires_at: new Date(Date.now() + 60_000).toISOString(),
	};
	const ordered = Object.fromEntries(
		Object.values(getTableColumns(historySessions)).map((column, index) => [
			`c${index}`,
			row[column.name] ?? null,
		]),
	);
	const signedIn: CustomerDatabaseBinding = {
		query: async (value) => {
			if (!(value as CustomerDatabaseQuery).text.includes('"history_sessions"'))
				throw new Error("Unexpected private database read");
			return { command: "SELECT", rows: [ordered], rowCount: 1 };
		},
		transaction: async () => [],
	};
	return bindings({ OHMYHOST_DATABASE: signedIn, ...overrides });
}
const signedInHeaders = { cookie: `signmos_history_session=${sessionSecret}` };

// Probe routes are added before the first request: Hono builds its matcher then.
beforeAll(() => {
	const echo = (c: Context) =>
		c.json(Object.fromEntries(trustHeaders.map((name) => [name, c.req.header(name) ?? null])));
	apiHono.get("/auth/__echo", echo);
	apiHono.get("/__echo", echo);
	apiHono.get("/auth/__bucket", (c) => {
		const env = c.env as Env;
		const bucket = env.DOCUMENTS_BUCKET;
		return c.json({
			same: bucket === env.DOCUMENTS_BUCKET,
			port: [typeof bucket?.get, typeof bucket?.put, typeof bucket?.delete],
		});
	});
});

describe("hosted request pipeline in front of TanStack Start", () => {
	it("answers the health probe itself, without a session, a database call or storage setup", async () => {
		const { next, result } = serve("/api/health/live");
		const response = (await result) as Response;
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: "ok" });
		expect(next).not.toHaveBeenCalled();
		expect(database.query).not.toHaveBeenCalled();
	});

	it("denies API requests without an administrator session and never reaches the app", async () => {
		const { next, result } = serve("/api/contracts");
		const response = (await result) as Response;
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "ADMIN_SESSION_REQUIRED" },
		});
		expect(next).not.toHaveBeenCalled();
	});

	it("redirects unauthenticated page requests to the login without rendering them", async () => {
		for (const path of ["/", "/my-documents", "/agent.md", "/openapi.json"]) {
			const { next, result } = serve(path);
			const response = (await result) as Response;
			expect(response.status, path).toBe(303);
			expect(response.headers.get("location")).toBe("/login");
			expect(next).not.toHaveBeenCalled();
		}
	});

	it("hands public pages to the app unchanged, inside the request database scope", async () => {
		for (const path of ["/login", "/signing/token", "/signing-verifications/token"]) {
			const next = vi.fn(async () => {
				expect(() => getDb()).not.toThrow();
				return { page: path };
			});
			await expect(
				serveHostedRequest(new Request(`${origin}${path}`), bindings(), next),
			).resolves.toEqual({ page: path });
			expect(next).toHaveBeenCalledOnce();
		}
		expect(() => getDb()).toThrow("outside an active request scope");
	});

	it("keeps the app reachable but the API closed while administrators are not configured", async () => {
		const env = bindings({ SIGN_ADMIN_EMAILS: undefined });
		const api = serve("/api/contracts", env);
		const response = (await api.result) as Response;
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "ADMIN_NOT_CONFIGURED" },
		});
		const page = serve("/login", env);
		await expect(page.result).resolves.toBe("app-response");
	});

	it("does not trust internal or clock override headers sent by the client", async () => {
		const { result } = serve("/api/contracts", bindings(), {
			headers: { "x-internal-user-id": "owner@example.com", "x-now": "2030-01-01T00:00:00Z" },
		});
		expect(((await result) as Response).status).toBe(403);
	});

	it("hands the API the gate's request, never the client's: forged trust headers do not arrive", async () => {
		// A public route sees none of them. Signing routes read x-now to judge whether a link has
		// expired, owner routes read x-internal-user-id as the verified identity.
		const publicRoute = serve("/api/auth/__echo", bindings(), { headers: forgedHeaders });
		const unauthenticated = (await publicRoute.result) as Response;
		await expect(unauthenticated.json()).resolves.toEqual({
			"x-now": null,
			"x-internal-user-id": null,
			"x-signmos-debug": null,
			"x-sender-session-token": null,
		});
		// A route behind the gate sees the administrator the session proves, not the one claimed.
		const gated = serve("/api/__echo", await signedInBindings(), {
			headers: { ...forgedHeaders, ...signedInHeaders },
		});
		await expect(((await gated.result) as Response).json()).resolves.toEqual({
			"x-now": null,
			"x-internal-user-id": "owner@example.com",
			"x-signmos-debug": null,
			"x-sender-session-token": null,
		});
	});

	it("serves the agent guide and the OpenAPI contract to a signed-in administrator, not to the app", async () => {
		const env = await signedInBindings();
		const guide = serve("/agent.md", env, { headers: signedInHeaders });
		const guideResponse = (await guide.result) as Response;
		expect(guideResponse.status).toBe(200);
		expect(guideResponse.headers.get("content-type")).toContain("text/markdown");
		const contract = serve("/openapi.json", env, { headers: signedInHeaders });
		const contractResponse = (await contract.result) as Response;
		expect(contractResponse.status).toBe(200);
		await expect(contractResponse.json()).resolves.toMatchObject({ openapi: expect.any(String) });
		expect(guide.next).not.toHaveBeenCalled();
		expect(contract.next).not.toHaveBeenCalled();
	});

	it("gives the API one private document bucket, built when it first asks for it", async () => {
		const env = bindings({
			OHMYHOST_STORAGE_GATEWAY_URL: "https://private-storage.example.com",
			OHMYHOST_STORAGE_KEY: "s".repeat(43),
			OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			OHMYHOST_ENVIRONMENT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		});
		const { result } = serve("/api/auth/__bucket", env);
		await expect(((await result) as Response).json()).resolves.toEqual({
			same: true,
			port: ["function", "function", "function"],
		});
	});
});
