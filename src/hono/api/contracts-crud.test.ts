import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { PDFDocument } from "pdf-lib";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { hashHistoryCredential } from "@/db/history-access/request";
import { withDatabase } from "@/db/setup";
import { createAdminCsrfToken } from "@/omh/auth";
import contractsEndpoint from "./contracts";

const owner = "owner@amerged.com";
const token = "signmos_contract_crud_owner_token";
const baseUrl = "https://sign.amerged.com";
let postgres: PGlite;
let calls = 0;
let storageCalls = 0;
let env: Env;
let objects: Map<string, Uint8Array>;
let definition: {
	title: string;
	recipients: { index: number; name: string; email: string }[];
	fields: {
		recipient: number;
		name: string;
		type: "signature";
		label: string;
		required: boolean;
	}[];
};
let pdfBytes: Uint8Array;
let afterPut: (() => Promise<void>) | undefined;
let deleteFails = false;
let loseSourceCommitReceipt = false;

function wire(result: Results) {
	return {
		command: result.command ?? "SELECT",
		rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length,
		rows: JSON.parse(JSON.stringify(result.rows)) as Record<string, unknown>[],
	};
}
function failure(error: unknown) {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
		return { type: "ohmyhost.database-error/v1", sqlstate: error.code };
	throw error;
}
const binding: CustomerDatabaseBinding = {
	query: async (raw) => {
		calls++;
		const query = raw as CustomerDatabaseQuery;
		try {
			return wire(await postgres.query(query.text, [...query.values]));
		} catch (error) {
			return failure(error);
		}
	},
	transaction: async (raw) => {
		calls++;
		try {
			const results = await postgres.transaction(async (transaction) => {
				const results = [];
				for (const query of raw as CustomerDatabaseQuery[]) {
					expect(query.values.length).toBeLessThanOrEqual(100);
					results.push(wire(await transaction.query(query.text, [...query.values])));
				}
				return results;
			});
			if (
				loseSourceCommitReceipt &&
				(raw as CustomerDatabaseQuery[]).some((query) =>
					query.text.includes("insert into source_documents"),
				)
			) {
				loseSourceCommitReceipt = false;
				return { type: "ohmyhost.database-error/v1", sqlstate: "08006" };
			}
			return results;
		} catch (error) {
			return failure(error);
		}
	},
};

async function request(
	path: string,
	method = "GET",
	body?: unknown,
	key: string = crypto.randomUUID(),
	authHeaders: Record<string, string> = { authorization: `Bearer ${token}` },
) {
	calls = 0;
	storageCalls = 0;
	const multipart = body instanceof FormData;
	const response = await withDatabase({ OHMYHOST_DATABASE: binding }, async () =>
		contractsEndpoint.fetch(
			new Request(`${baseUrl}${path}`, {
				method,
				headers: {
					...authHeaders,
					...(method !== "GET" ? { "idempotency-key": key } : {}),
					...(!multipart && body !== undefined ? { "content-type": "application/json" } : {}),
				},
				...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}),
			}),
			env,
		),
	);
	expect(calls + storageCalls).toBeLessThanOrEqual(10);
	return response;
}
function upload(value = definition, bytes = pdfBytes) {
	const form = new FormData();
	form.set(
		"pdf",
		new Blob([Uint8Array.from(bytes).buffer], { type: "application/pdf" }),
		"agreement.pdf",
	);
	form.set("definition", JSON.stringify(value));
	return form;
}
async function draft() {
	const response = await request("/drafts", "POST", upload());
	expect(response.status).toBe(201);
	return ((await response.json()) as { data: { id: string } }).data.id;
}

beforeAll(async () => {
	postgres = new PGlite();
	const migrations = new URL("../../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(file, migrations), "utf8"));
}, 20_000);
afterAll(async () => {
	await postgres.close();
});
beforeEach(async () => {
	await postgres.exec("TRUNCATE envelopes,agentic_api_tokens CASCADE");
	await postgres.query(
		"INSERT INTO agentic_api_tokens(email,name,token_hash,token_hint) VALUES($1,'CRUD fixture',$2,'fixture')",
		[owner, await hashAgenticCredential(token)],
	);
	objects = new Map();
	afterPut = undefined;
	deleteFails = false;
	loseSourceCommitReceipt = false;
	const bucket = {
		put: async (key: string, bytes: Uint8Array) => {
			storageCalls += 3;
			objects.set(key, bytes);
			await afterPut?.();
			return null;
		},
		get: async (key: string) => {
			storageCalls++;
			const bytes = objects.get(key);
			return bytes ? { arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
		},
		delete: async (keys: string | string[]) => {
			storageCalls++;
			if (deleteFails) throw new Error("storage unavailable");
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		},
	} as unknown as R2Bucket;
	env = {
		SIGN_ADMIN_EMAILS: owner,
		APP_BASE_URL: baseUrl,
		DOCUMENTS_BUCKET: bucket,
		SIGN_FROM_EMAIL: "sign@amerged.com",
		OHMYHOST_MAIL_GATEWAY_URL: "https://mail.example.com",
		OHMYHOST_MAIL_KEY: "m".repeat(43),
		OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	} as Env;
	definition = {
		title: "Contract draft",
		recipients: [
			{ index: 1, name: "Owner", email: owner },
			{ index: 2, name: "Ada", email: "ada@example.com" },
		],
		fields: [
			{ recipient: 1, name: "sign", type: "signature", label: "Signature", required: true },
			{ recipient: 2, name: "sign", type: "signature", label: "Signature", required: true },
		],
	};
	const pdf = await PDFDocument.create();
	const page = pdf.addPage([612, 792]);
	page.drawText("{{1.sign}}", { x: 80, y: 700 });
	page.drawText("{{2.sign}}", { x: 80, y: 600 });
	pdfBytes = Uint8Array.from(await pdf.save());
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("Invitation must use outbox");
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

it("creates an explicitly assigned sender as an unsigned draft and replays exactly", async () => {
	const first = await request("/drafts", "POST", upload(), "draft-once");
	expect(first.status).toBe(201);
	const result = await first.json();
	expect(result).toMatchObject({
		data: {
			status: "draft",
			title: definition.title,
			recipients: [
				{ email: owner, status: "pending" },
				{ email: "ada@example.com", status: "pending" },
			],
		},
	});
	await expect((await request("/drafts", "POST", upload(), "draft-once")).json()).resolves.toEqual(
		result,
	);
	expect(
		(await request("/drafts", "POST", upload({ ...definition, title: "Changed" }), "draft-once"))
			.status,
	).toBe(409);
	expect((await postgres.query("SELECT count(*)::integer AS count FROM envelopes")).rows).toEqual([
		{ count: 1 },
	]);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM field_values")).rows,
	).toEqual([{ count: 0 }]);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM signer_tokens")).rows,
	).toEqual([{ count: 0 }]);
	expect(fetch).not.toHaveBeenCalled();
});

it("edits draft metadata and recipients and replaces PDF definitions atomically", async () => {
	const id = await draft();
	const updated = {
		...definition,
		title: "Updated",
		recipients: definition.recipients.map((recipient) => ({
			...recipient,
			name: `${recipient.name} Updated`,
		})),
	};
	expect(
		(await request(`/${id}`, "PATCH", { title: updated.title, recipients: updated.recipients }))
			.status,
	).toBe(200);
	const detail = await (await request(`/${id}`)).json();
	expect(detail).toMatchObject({
		data: {
			title: "Updated",
			definition: { recipients: updated.recipients, fields: definition.fields },
		},
	});
	const replacement = await request(
		`/${id}/pdf`,
		"PUT",
		upload({ ...updated, title: "Replacement" }),
	);
	expect(replacement.status).toBe(200);
	expect(
		(
			await postgres.query(
				"SELECT count(*)::integer AS count FROM source_documents WHERE envelope_id=$1",
				[id],
			)
		).rows,
	).toEqual([{ count: 2 }]);
	expect(
		(
			await postgres.query(
				"SELECT count(*)::integer AS count FROM envelope_artifact_versions WHERE envelope_id=$1",
				[id],
			)
		).rows,
	).toEqual([{ count: 2 }]);
	expect(
		(await request(`/${id}`, "PATCH", { fields: [{ ...definition.fields[0], name: "missing" }] }))
			.status,
	).toBe(400);
	await expect((await request(`/${id}`)).json()).resolves.toMatchObject({
		data: { title: "Replacement" },
	});
});

it("manually sends personal links once and freezes the document without sending invitations", async () => {
	const id = await draft();
	const sent = await request(`/${id}/send`, "POST", { delivery: "manual" }, "manual-once");
	expect(sent.status).toBe(200);
	const body = await sent.json();
	expect(body).toMatchObject({
		data: {
			id,
			status: "sent",
			signingLinks: [
				{
					email: owner,
					url: expect.stringContaining("/signing-verifications/"),
					expiresAt: expect.any(String),
				},
				{ email: "ada@example.com", url: expect.stringContaining("/signing-verifications/") },
			],
		},
	});
	await expect(
		(await request(`/${id}/send`, "POST", { delivery: "manual" }, "manual-once")).json(),
	).resolves.toEqual(body);
	expect((await request(`/${id}`, "PATCH", { title: "Frozen" })).status).toBe(409);
	expect((await request(`/${id}/pdf`, "PUT", upload())).status).toBe(409);
	expect((await request(`/${id}`, "DELETE")).status).toBe(409);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM contract_invitation_outbox"))
			.rows,
	).toEqual([{ count: 0 }]);
	expect(JSON.stringify(await (await request(`/${id}`)).json())).not.toContain(
		"signing-verifications",
	);
	expect(fetch).not.toHaveBeenCalled();
	expect((await request(`/${id}/cancel`, "POST", {})).status).toBe(200);
	expect((await postgres.query("SELECT DISTINCT status FROM signer_tokens")).rows).toEqual([
		{ status: "revoked" },
	]);
});

it("queues email invitations durably and returns links while keeping them inactive", async () => {
	const id = await draft();
	const sent = await request(`/${id}/send`, "POST", { delivery: "email" });
	expect(sent.status).toBe(202);
	await expect(sent.json()).resolves.toMatchObject({
		data: { status: "queued", signingLinks: expect.any(Array) },
	});
	expect((await postgres.query("SELECT status FROM contract_invitation_outbox")).rows).toEqual([
		{ status: "queued" },
		{ status: "queued" },
	]);
	expect((await postgres.query("SELECT DISTINCT status FROM signer_tokens")).rows).toEqual([
		{ status: "revoked" },
	]);
	expect(fetch).not.toHaveBeenCalled();
});

it("isolates owners and erases all private PDF versions before deleting the draft", async () => {
	const id = await draft();
	await request(`/${id}/pdf`, "PUT", upload());
	await postgres.query("UPDATE envelopes SET created_by='other@amerged.com' WHERE id=$1", [id]);
	for (const [method, path, body] of [
		["GET", `/${id}`, undefined],
		["PATCH", `/${id}`, { title: "Other" }],
		["DELETE", `/${id}`, undefined],
		["POST", `/${id}/send`, { delivery: "manual" }],
	] as const)
		expect((await request(path, method, body)).status).toBe(404);
	await postgres.query("UPDATE envelopes SET created_by=$1 WHERE id=$2", [owner, id]);
	deleteFails = true;
	expect((await request(`/${id}`, "DELETE")).status).toBe(503);
	expect((await request(`/${id}/send`, "POST", { delivery: "manual" })).status).toBe(409);
	deleteFails = false;
	expect((await request(`/${id}`, "DELETE")).status).toBe(200);
	expect(objects.size).toBe(0);
	expect((await request(`/${id}`)).status).toBe(404);
});

it("rejects a replacement race within ten private calls and retains its uncommitted file manifest", async () => {
	const id = await draft();
	afterPut = async () => {
		await postgres.query("UPDATE envelopes SET created_by='other@amerged.com' WHERE id=$1", [id]);
	};
	expect((await request(`/${id}/pdf`, "PUT", upload())).status).toBe(409);
	expect(objects.size).toBe(2);
	expect(
		(
			await postgres.query(
				"SELECT count(*)::integer AS count FROM source_documents WHERE envelope_id=$1",
				[id],
			)
		).rows,
	).toEqual([{ count: 1 }]);
});

it("preserves bounded PDF and field validation for JSON draft creation", async () => {
	const requestBody = {
		title: "Coordinates",
		recipient: { name: "Owner", email: owner },
		pdf: { filename: "agreement.pdf", base64: Buffer.from(pdfBytes).toString("base64") },
	};
	expect((await request("/drafts", "POST", requestBody)).status).toBe(201);
	const oversized = {
		...requestBody,
		pdf: { ...requestBody.pdf, base64: "A".repeat(Math.ceil((2 * 1024 * 1024) / 3) * 4 + 4) },
	};
	const large = await request("/drafts", "POST", oversized);
	expect(large.status).toBe(413);
	await expect(large.json()).resolves.toMatchObject({ error: { code: "SOURCE_PDF_TOO_LARGE" } });
	const fields = Array.from({ length: 21 }, (_, index) => ({
		type: index === 0 ? "signature" : "date",
		page: 1,
		x: 72,
		y: 100,
		width: 100,
		height: 20,
	}));
	const tooMany = await request("/drafts", "POST", { ...requestBody, fields });
	expect(tooMany.status).toBe(413);
	await expect(tooMany.json()).resolves.toMatchObject({
		error: { code: "SOURCE_PDF_TOO_MANY_FIELDS" },
	});
});

it("does not erase an in-flight replacement before its private upload finishes", async () => {
	const id = await draft();
	let deletionStatus = 0;
	afterPut = async () => {
		deletionStatus = (await request(`/${id}`, "DELETE")).status;
	};
	expect((await request(`/${id}/pdf`, "PUT", upload())).status).toBe(200);
	expect(deletionStatus).toBe(409);
	expect(objects.size).toBe(2);
	expect((await request(`/${id}`, "DELETE")).status).toBe(200);
	expect(objects.size).toBe(0);
});

it("can review and send an existing legacy draft left by an uncertain invitation", async () => {
	env = {
		...env,
		OHMYHOST_MAIL_GATEWAY_URL: "",
		OHMYHOST_MAIL_KEY: "",
		OHMYHOST_PROJECT_ID: "",
		RESEND_API_KEY: "test",
		RESEND_FROM_EMAIL: "sign@amerged.com",
		RESEND_REPLY_TO_EMAIL: owner,
	} as Env;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("provider failure", { status: 502 })),
	);
	const legacy = {
		title: "Legacy retry",
		recipient: { name: "Ada", email: "ada@example.com" },
		pdf: { filename: "agreement.pdf", base64: Buffer.from(pdfBytes).toString("base64") },
	};
	expect((await request("/", "POST", legacy)).status).toBe(502);
	const row = (await postgres.query<{ id: string }>("SELECT id FROM envelopes")).rows[0];
	if (!row) throw new Error("Missing legacy draft");
	expect((await request(`/${row.id}`, "PATCH", { title: "Reviewed retry" })).status).toBe(200);
	const sent = await request(`/${row.id}/send`, "POST", { delivery: "manual" });
	expect(sent.status).toBe(200);
	await expect(sent.json()).resolves.toMatchObject({
		data: { title: "Reviewed retry", signingLinks: [{ email: "ada@example.com" }] },
	});
});

it("requires browser CSRF and keeps the whole browser CRUD flow within ten private calls per request", async () => {
	const session = crypto.randomUUID();
	await postgres.query(
		"INSERT INTO history_access_links(id,email,credential_hash,status,expires_at) VALUES($1,$2,$3,'consumed',now()+interval '1 hour')",
		[session, owner, "a".repeat(64)],
	);
	await postgres.query(
		"INSERT INTO history_sessions(link_id,email,session_hash,status,expires_at) VALUES($1,$2,$3,'active',now()+interval '1 hour')",
		[session, owner, await hashHistoryCredential(session)],
	);
	const cookie = `signmos_history_session=${session}`;
	expect((await request("/drafts", "POST", upload(), "csrf-denied", { cookie })).status).toBe(403);
	const headers = { cookie, origin: baseUrl, "x-csrf-token": await createAdminCsrfToken(session) };
	const first = await request("/drafts", "POST", upload(), "browser-draft", headers);
	expect(first.status).toBe(201);
	const body = await first.json();
	await expect(
		(await request("/drafts", "POST", upload(), "browser-draft", headers)).json(),
	).resolves.toEqual(body);
	const id = (body as { data: { id: string } }).data.id;
	expect(
		(await request(`/${id}`, "PATCH", { title: "Browser draft" }, "browser-patch", headers)).status,
	).toBe(200);
	expect((await request(`/${id}/pdf`, "PUT", upload(), "browser-pdf", headers)).status).toBe(200);
	expect((await request(`/${id}`, "DELETE", undefined, "browser-delete", headers)).status).toBe(
		200,
	);
});

it("retains the active source when its save committed but the private database receipt was lost", async () => {
	loseSourceCommitReceipt = true;
	const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
	try {
		expect((await request("/drafts", "POST", upload(), "lost-commit-receipt")).status).toBe(201);
		expect(objects.size).toBe(1);
		const replay = await request("/drafts", "POST", upload(), "lost-commit-receipt");
		expect(replay.status).toBe(201);
		const id = ((await replay.json()) as { data: { id: string } }).data.id;
		expect((await request(`/${id}/send`, "POST", { delivery: "manual" })).status).toBe(200);
	} finally {
		logged.mockRestore();
	}
});
