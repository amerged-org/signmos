import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { withDatabase } from "@/db/setup";
import { apiHono } from "@/hono/api";

const envelope = "10000000-0000-4000-8000-000000000001";
const recipient = "20000000-0000-4000-8000-000000000001";
const tokenId = "30000000-0000-4000-8000-000000000001";
const finalId = "40000000-0000-4000-8000-000000000001";
const token = "existing-personal-signer-token";
const now = "2026-11-14T12:00:00Z";
let postgres: PGlite;
let code: string;
let messages: string[];
let fileReads: number;
const env = {
	CLOUDFLARE_ENV: "production",
	SIGN_OTP_SECRET: "o".repeat(43),
	OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	OHMYHOST_MAIL_GATEWAY_URL: "https://mail.private.example",
	OHMYHOST_MAIL_KEY: "m".repeat(43),
	SIGN_FROM_EMAIL: "sign@example.com",
	SIGN_REPLY_TO_EMAIL: "owner@example.com",
	DOCUMENTS_BUCKET: {
		get: async () => {
			fileReads++;
			return null;
		},
	},
} as unknown as Env;
const result = (value: Results) => ({
	command: value.command ?? "SELECT",
	rowCount: value.rowCount ?? value.affectedRows ?? value.rows.length,
	rows: JSON.parse(JSON.stringify(value.rows)) as Record<string, unknown>[],
});
const binding: CustomerDatabaseBinding = {
	query: async (input) => {
		const q = input as CustomerDatabaseQuery;
		return result(await postgres.query(q.text, [...q.values]));
	},
	transaction: async (input) =>
		postgres.transaction(async (tx) => {
			const results = [];
			for (const q of input as CustomerDatabaseQuery[])
				results.push(result(await tx.query(q.text, [...q.values])));
			return results;
		}),
};
function request(
	path: string,
	options: {
		method?: string;
		body?: unknown;
		cookie?: string;
		at?: string;
		ip?: string;
		origin?: string;
	} = {},
) {
	return withDatabase({ OHMYHOST_DATABASE: binding }, async () =>
		apiHono.request(
			path,
			{
				method: options.method ?? "GET",
				headers: {
					"x-now": options.at ?? now,
					"cf-connecting-ip": options.ip ?? "192.0.2.1",
					...(options.body ? { "content-type": "application/json" } : {}),
					...(options.cookie ? { cookie: options.cookie } : {}),
					...(options.origin ? { origin: options.origin } : {}),
				},
				...(options.body ? { body: JSON.stringify(options.body) } : {}),
			},
			env,
		),
	);
}
async function send(at = now, ip?: string) {
	return request(`/api/signing/${token}/email-code/request`, { method: "POST", body: {}, at, ip });
}
async function verify(value = code, at = now) {
	return request(`/api/signing/${token}/email-code/verify`, {
		method: "POST",
		body: { code: value },
		at,
	});
}
beforeAll(async () => {
	postgres = new PGlite();
	const base = new URL("../../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(base)).filter((f) => f.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(file, base), "utf8"));
}, 20000);
afterAll(async () => postgres.close());
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
	await postgres.exec("TRUNCATE envelopes CASCADE; TRUNCATE rate_limit_records");
	await postgres.query(
		"INSERT INTO envelopes(id,created_by,status) VALUES($1,'owner@example.com','sent')",
		[envelope],
	);
	await postgres.query(
		"INSERT INTO envelope_recipients(id,envelope_id,name,email,status) VALUES($1,$2,'Ada','ada@example.com','sent')",
		[recipient, envelope],
	);
	await postgres.query(
		"INSERT INTO signer_tokens(id,envelope_id,recipient_id,token,expires_at,verified_at) VALUES($1,$2,$3,$4,'2026-11-21T12:00:00Z',$5)",
		[tokenId, envelope, recipient, token, now],
	);
	messages = [];
	code = "";
	fileReads = 0;
	vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
		const body = input instanceof Request ? await input.text() : String(init?.body);
		messages.push(body);
		code = body.match(/\b\d{6}\b/)?.[0] ?? "";
		return Response.json(
			{ state: "accepted", request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", message_id: "fixture" },
			{ status: 202 },
		);
	});
});
it("requires email proof for every personal read and mutation even when an old token is marked verified", async () => {
	for (const [suffix, method, body] of [
		["", "GET", undefined],
		["/source-pdf", "GET", undefined],
		["/final-pdf", "GET", undefined],
		["/fields/50000000-0000-4000-8000-000000000001", "PATCH", { x: 1, y: 1 }],
		["/complete", "POST", { signatureName: "Ada" }],
		["/decline", "POST", { reason: "No" }],
		["/change-request", "POST", { comment: "Please change" }],
	] as const) {
		const response = await request(`/api/signing/${token}${suffix}`, { method, body });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: "PARTNER_VERIFICATION_REQUIRED", emailHint: "a•••@example.com" },
		});
	}
	expect(fileReads).toBe(0);
});
it("does not turn an email scanner GET into identity proof", async () => {
	await postgres.exec("UPDATE signer_tokens SET verified_at=NULL");
	const inspected = await request(`/api/signing/verifications/${token}`);
	expect(inspected.status).toBe(200);
	expect(await inspected.json()).toMatchObject({
		data: { status: "email_verification_required", emailHint: "a•••@example.com" },
	});
	expect((await postgres.query("SELECT verified_at FROM signer_tokens")).rows).toEqual([
		{ verified_at: null },
	]);
	expect((await request(`/api/signing/${token}/source-pdf`)).status).toBe(403);
});
it("delivers only a six digit email code, stores no code, and redeems it once into a scoped HttpOnly session", async () => {
	const sent = await send();
	expect(sent.status).toBe(200);
	expect(code).toMatch(/^\d{6}$/);
	expect(await sent.text()).not.toContain(code);
	const stored = await postgres.query("SELECT * FROM signer_email_challenges");
	expect(JSON.stringify(stored.rows)).not.toContain(code);
	const verified = await verify();
	expect(verified.status).toBe(200);
	const cookie = verified.headers.get("set-cookie") ?? "";
	expect(cookie).toContain("HttpOnly");
	expect(cookie).toContain("Secure");
	expect(cookie).toContain("SameSite=Strict");
	expect(cookie).toContain("Path=/api/");
	expect((await verify()).status).toBe(400);
	expect((await request(`/api/signing/${token}/source-pdf`, { cookie })).status).toBe(404);
	await postgres.query(
		"INSERT INTO envelope_recipients(id,envelope_id,name,email,status) VALUES('20000000-0000-4000-8000-000000000002',$1,'Other','other@example.com','sent')",
		[envelope],
	);
	await postgres.query(
		"INSERT INTO signer_tokens(envelope_id,recipient_id,token,expires_at,verified_at) VALUES($1,'20000000-0000-4000-8000-000000000002','other-token','2026-11-21T12:00:00Z',$2)",
		[envelope, now],
	);
	expect((await request("/api/signing/other-token/source-pdf", { cookie })).status).toBe(403);
	await postgres.exec("UPDATE signer_tokens SET status='revoked'");
	expect((await request(`/api/signing/${token}/source-pdf`, { cookie })).status).toBe(404);
});
it("expires at ten minutes and locks the fifth wrong attempt without allowing a correct sixth", async () => {
	expect((await send()).status).toBe(200);
	expect((await verify(code, "2026-11-14T12:10:00Z")).status).toBe(400);
	expect((await send("2026-11-14T12:11:00Z")).status).toBe(200);
	for (let n = 0; n < 5; n++)
		expect(
			(await verify(code === "000000" ? "111111" : "000000", "2026-11-14T12:11:00Z")).status,
		).toBe(400);
	expect((await verify(code, "2026-11-14T12:11:00Z")).status).toBe(400);
});
it("allows only one concurrent code redemption and preserves all five failed attempts", async () => {
	await send();
	const responses = await Promise.all([verify(), verify()]);
	expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
	await send("2026-11-14T12:01:00Z");
	await Promise.all(
		Array.from({ length: 5 }, () =>
			verify(code === "000000" ? "111111" : "000000", "2026-11-14T12:01:00Z"),
		),
	);
	expect((await verify(code, "2026-11-14T12:01:00Z")).status).toBe(400);
});
it("enforces resend cooldown and an hourly recipient cap atomically", async () => {
	expect((await send()).status).toBe(200);
	const limited = await send();
	expect(limited.status).toBe(429);
	expect(limited.headers.get("retry-after")).toBe("60");
	for (let n = 1; n < 5; n++) expect((await send(`2026-11-14T12:0${n}:00Z`)).status).toBe(200);
	expect((await send("2026-11-14T12:05:00Z", "192.0.2.2")).status).toBe(429);
	expect(messages).toHaveLength(5);
});
it("rejects cross-origin OTP mutations", async () => {
	const response = await request(`/api/signing/${token}/email-code/request`, {
		method: "POST",
		body: {},
		origin: "https://attacker.example",
	});
	expect(response.status).toBe(403);
	expect(messages).toHaveLength(0);
});
it("requires OTP for completed signer links and refuses the public final-document id bypass", async () => {
	await postgres.exec(
		"UPDATE envelopes SET status='completed'; UPDATE envelope_recipients SET status='completed'",
	);
	await postgres.query(
		"INSERT INTO final_documents(id,envelope_id,r2_key,sha256,byte_size,content_type) VALUES($1,$2,'final.pdf',repeat('a',64),123,'application/pdf')",
		[finalId, envelope],
	);
	for (const path of [
		`/api/signing/${token}`,
		`/api/final-documents/${token}`,
		`/api/final-documents/${token}/pdf`,
	])
		expect((await request(path)).status).toBe(403);
	for (const path of [`/api/final-documents/${finalId}`, `/api/final-documents/${finalId}/pdf`])
		expect((await request(path)).status).toBe(404);
	expect((await send()).status).toBe(200);
	const cookie = (await verify()).headers.get("set-cookie") ?? "";
	expect((await request(`/api/final-documents/${token}`, { cookie })).status).toBe(200);
});

it("marks email-proof and protected document responses as private non-cacheable", async () => {
	const blocked = await request(`/api/signing/${token}`);
	expect(blocked.headers.get("cache-control")).toBe("no-store");
	const sent = await send();
	expect(sent.headers.get("cache-control")).toBe("no-store");
	const verified = await verify();
	expect(verified.headers.get("cache-control")).toBe("no-store");
	const cookie = verified.headers.get("set-cookie") ?? "";
	await postgres.exec(
		"UPDATE envelopes SET status='completed'; UPDATE envelope_recipients SET status='completed'",
	);
	await postgres.query(
		"INSERT INTO final_documents(id,envelope_id,r2_key,sha256,byte_size,content_type) VALUES($1,$2,'final.pdf',repeat('a',64),123,'application/pdf')",
		[finalId, envelope],
	);
	expect(
		(await request(`/api/final-documents/${token}`, { cookie })).headers.get("cache-control"),
	).toBe("no-store");
});

it("does not send two codes when resend requests race", async () => {
	const responses = await Promise.all([send(), send()]);
	expect(responses.map((r) => r.status).sort()).toEqual([200, 429]);
	expect(messages).toHaveLength(1);
});
it("limits a shared IP across recipients while allowing an independent IP", async () => {
	for (let index = 0; index < 21; index++) {
		const suffix = String(index + 10).padStart(12, "0");
		const eid = `10000000-0000-4000-8000-${suffix}`;
		const rid = `20000000-0000-4000-8000-${suffix}`;
		await postgres.query(
			"INSERT INTO envelopes(id,created_by,status) VALUES($1,'owner@example.com','sent')",
			[eid],
		);
		await postgres.query(
			"INSERT INTO envelope_recipients(id,envelope_id,name,email,status) VALUES($1,$2,'Signer',$3,'sent')",
			[rid, eid, `signer${index}@example.com`],
		);
		await postgres.query(
			"INSERT INTO signer_tokens(envelope_id,recipient_id,token,expires_at) VALUES($1,$2,$3,'2026-11-21T12:00:00Z')",
			[eid, rid, `ip-limit-${index}`],
		);
		const response = await request(`/api/signing/ip-limit-${index}/email-code/request`, {
			method: "POST",
			body: {},
		});
		expect(response.status).toBe(index < 20 ? 200 : 429);
	}
	expect(messages).toHaveLength(20);
	const independent = await request("/api/signing/ip-limit-20/email-code/request", {
		method: "POST",
		body: {},
		ip: "192.0.2.2",
		at: "2026-11-14T12:01:00Z",
	});
	expect(independent.status).toBe(200);
});
it("fails closed without a dedicated OTP secret and does not expose a gateway failure", async () => {
	const missing = await withDatabase({ OHMYHOST_DATABASE: binding }, async () =>
		apiHono.request(
			`/api/signing/${token}/email-code/request`,
			{ method: "POST", headers: { "x-now": now } },
			{ ...env, SIGN_OTP_SECRET: undefined },
		),
	);
	expect(missing.status).toBe(503);
	expect(await missing.json()).toMatchObject({ error: { code: "EMAIL_VERIFICATION_UNAVAILABLE" } });
	expect(messages).toHaveLength(0);
	vi.stubGlobal("fetch", async () => {
		throw new Error("private gateway diagnostics must not be returned");
	});
	const failed = await send();
	expect(failed.status).toBe(503);
	expect(await failed.text()).not.toContain("private gateway diagnostics");
});
it("expires the scoped session and invalidates it when the recipient identity changes", async () => {
	await send();
	const cookie = (await verify()).headers.get("set-cookie") ?? "";
	expect(
		(await request(`/api/signing/${token}/source-pdf`, { cookie, at: "2026-11-14T20:00:00Z" }))
			.status,
	).toBe(403);
	await postgres.exec("UPDATE envelope_recipients SET email='changed@example.com'");
	expect((await request(`/api/signing/${token}/source-pdf`, { cookie })).status).toBe(403);
});
