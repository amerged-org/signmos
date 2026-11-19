import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { hashHistoryCredential } from "@/db/history-access";
import { withDatabase } from "@/db/setup";
import { createAdminCsrfToken } from "./auth";
import authEndpoint from "./auth-routes";

const email = "owner@example.com";
const rawSession = "admin-cookie-credential-that-is-not-an-api-token";
const linkId = "10000000-0000-4000-8000-000000000001";
let postgres: PGlite;
let calls: { query: number; transaction: number };
let conflicts: number;

function result(value: Results) {
	return {
		command: value.command ?? "SELECT",
		rowCount: value.rowCount ?? value.affectedRows ?? value.rows.length,
		rows: JSON.parse(JSON.stringify(value.rows)) as Record<string, unknown>[],
	};
}
function failure(error: unknown) {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
		return { type: "ohmyhost.database-error/v1", sqlstate: error.code };
	throw error;
}
const binding: CustomerDatabaseBinding = {
	query: async (raw) => {
		calls.query += 1;
		const query = raw as CustomerDatabaseQuery;
		if (conflicts > 0 && query.text.includes('insert into "agentic_api_tokens"')) {
			conflicts -= 1;
			const slot = query.values.find((value) => typeof value === "number");
			await postgres.query(
				"INSERT INTO agentic_api_tokens(email,name,token_hash,token_hint,status,active_slot) VALUES($1,'Concurrent token',$2,'hint','active',$3)",
				[email, crypto.randomUUID(), slot],
			);
		}
		try {
			return result(await postgres.query(query.text, [...query.values]));
		} catch (error) {
			return failure(error);
		}
	},
	transaction: async (raw) => {
		calls.transaction += 1;
		try {
			return await postgres.transaction(async (transaction) => {
				const results = [];
				for (const query of raw as CustomerDatabaseQuery[])
					results.push(result(await transaction.query(query.text, [...query.values])));
				return results;
			});
		} catch (error) {
			return failure(error);
		}
	},
};
async function request(
	path: string,
	method = "POST",
	body?: unknown,
	headers: Record<string, string> = {},
) {
	const csrf = await createAdminCsrfToken(rawSession);
	return withDatabase({ OHMYHOST_DATABASE: binding }, async () =>
		authEndpoint.fetch(
			new Request(`https://sign.example.com${path}`, {
				method,
				headers: {
					cookie: `signmos_history_session=${rawSession}`,
					origin: "https://sign.example.com",
					"x-csrf-token": csrf,
					"content-type": "application/json",
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
			{ SIGN_ADMIN_EMAILS: email } as Env,
		),
	);
}
function count() {
	return calls.query + calls.transaction;
}
function resetCalls() {
	calls = { query: 0, transaction: 0 };
}
beforeAll(async () => {
	postgres = new PGlite();
	const migrations = new URL("../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(file, migrations), "utf8"));
}, 20_000);
afterAll(async () => {
	await postgres.close();
});
beforeEach(async () => {
	await postgres.exec(
		"TRUNCATE history_access_links,agentic_access_links,agentic_api_tokens CASCADE",
	);
	await postgres.query(
		"INSERT INTO history_access_links(id,email,credential_hash,status,expires_at) VALUES($1,$2,'fixture-link-hash','consumed',$3)",
		[linkId, email, new Date(Date.now() + 3_600_000)],
	);
	await postgres.query(
		"INSERT INTO history_sessions(link_id,email,session_hash,status,expires_at) VALUES($1,$2,$3,'active',$4)",
		[linkId, email, await hashHistoryCredential(rawSession), new Date(Date.now() + 3_600_000)],
	);
	conflicts = 0;
	resetCalls();
});

it("creates and revokes an API token within ten real private database calls per request", async () => {
	const response = await request("/tokens", "POST", { name: "Contracts" });
	expect(response.status).toBe(201);
	expect(count()).toBe(6);
	const created = (await response.json()) as { data: { secret: string; token: { id: string } } };
	expect(created.data.secret).toMatch(/^signmos_[A-Za-z0-9_-]{43}$/);
	const persisted = await postgres.query(
		"SELECT to_jsonb(t) AS row FROM agentic_api_tokens t UNION ALL SELECT to_jsonb(s) FROM agentic_management_sessions s UNION ALL SELECT to_jsonb(l) FROM agentic_access_links l UNION ALL SELECT to_jsonb(e) FROM agentic_security_events e",
	);
	expect(JSON.stringify(persisted.rows)).not.toContain(created.data.secret);
	expect(JSON.stringify(persisted.rows)).not.toContain(rawSession);
	expect(
		(await postgres.query("SELECT status,session_hash FROM agentic_management_sessions")).rows,
	).toEqual([{ status: "revoked", session_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
	expect(
		(await postgres.query("SELECT event_type FROM agentic_security_events ORDER BY created_at"))
			.rows,
	).toEqual([
		{ event_type: "agentic.session.bridged" },
		{ event_type: "agentic.token.created" },
		{ event_type: "agentic.session.revoked" },
	]);
	resetCalls();
	expect((await request(`/tokens/${created.data.token.id}`, "DELETE")).status).toBe(200);
	expect(count()).toBe(6);
});

it("enforces five active tokens and cleans up bridges for limit, missing and other-owner requests", async () => {
	for (let index = 0; index < 5; index += 1) {
		resetCalls();
		expect((await request("/tokens", "POST", { name: `Token ${index}` })).status).toBe(201);
		expect(count()).toBe(6);
	}
	resetCalls();
	const limited = await request("/tokens", "POST", { name: "Sixth token" });
	expect(limited.status).toBe(409);
	expect(await limited.json()).toMatchObject({ error: { code: "API_TOKEN_LIMIT" } });
	expect(count()).toBe(4);
	const outsider = crypto.randomUUID();
	await postgres.query(
		"INSERT INTO agentic_api_tokens(id,email,name,token_hash,token_hint,status,active_slot) VALUES($1,'another@example.com','Another owner','another-hash','hint','active',1)",
		[outsider],
	);
	for (const id of [crypto.randomUUID(), outsider]) {
		resetCalls();
		expect((await request(`/tokens/${id}`, "DELETE")).status).toBe(404);
		expect(count()).toBe(4);
	}
	expect(
		(
			await postgres.query(
				"SELECT count(*)::integer AS count FROM agentic_management_sessions WHERE status='active'",
			)
		).rows,
	).toEqual([{ count: 0 }]);
	expect(
		(
			await postgres.query(
				"SELECT count(*)::integer AS count FROM agentic_api_tokens WHERE email=$1 AND status='active'",
				[email],
			)
		).rows,
	).toEqual([{ count: 5 }]);
});

it.each([
	2, 3,
])("bounds real unique-slot contention within ten calls after %i conflicting insert attempts", async (conflictingAttempts) => {
	conflicts = conflictingAttempts;
	const response = await request("/tokens", "POST", { name: "Concurrent integration" });
	expect(response.status).toBe(conflictingAttempts === 2 ? 201 : 409);
	expect(count()).toBe(conflictingAttempts === 2 ? 10 : 9);
	expect(conflicts).toBe(0);
	expect(
		(
			await postgres.query(
				"SELECT count(*)::integer AS count FROM agentic_api_tokens WHERE email=$1 AND status='active'",
				[email],
			)
		).rows,
	).toEqual([{ count: 3 }]);
	expect((await postgres.query("SELECT status FROM agentic_management_sessions")).rows).toEqual([
		{ status: "revoked" },
	]);
});

it.each([
	"cookie",
	"csrf",
	"origin",
	"allowlist",
])("retains the route's allowlisted cookie and CSRF boundary: %s", async (scenario) => {
	const headers: Record<string, string> = {};
	if (scenario === "cookie") headers.cookie = "";
	if (scenario === "csrf") headers["x-csrf-token"] = "invalid";
	if (scenario === "origin") headers.origin = "https://another.example.com";
	if (scenario === "allowlist")
		await postgres.exec("UPDATE history_sessions SET email='another@example.com'");
	const response = await request("/tokens", "POST", { name: "Denied integration" }, headers);
	expect(response.status).toBe(403);
	expect(count()).toBeLessThanOrEqual(1);
	expect((await postgres.query("SELECT * FROM agentic_management_sessions")).rows).toEqual([]);
	expect((await postgres.query("SELECT * FROM agentic_api_tokens")).rows).toEqual([]);
});
