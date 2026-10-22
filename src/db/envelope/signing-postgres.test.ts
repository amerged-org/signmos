import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { PDFDocument } from "pdf-lib";
import { withDatabase } from "@/db/setup";
import { apiHono } from "@/hono/api";
import { controlEnvelope } from "./controls";
import { resolveSignerToken } from "./signing";

const envelopeId = "10000000-0000-4000-8000-000000000001";
const recipientId = "20000000-0000-4000-8000-000000000001";
const tokenId = "30000000-0000-4000-8000-000000000001";
const sourceId = "40000000-0000-4000-8000-000000000001";
const token = "signer-private-test-token";
const now = "2026-10-21T14:00:00Z";
let postgres: PGlite;
let objects: Map<string, Uint8Array>;
let tombstones: Set<string>;
let failErasure = false;
let calls: { query: number; transaction: number; files: number; mail: number };
let beforeMail: (() => Promise<void>) | undefined;
let beforeSave: (() => Promise<void>) | undefined;
let mailAnswer: (() => Response) | undefined;
let beforePut: (() => Promise<void>) | undefined;
let beforeGet: (() => Promise<void>) | undefined;
let statements: CustomerDatabaseQuery[];

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
		statements.push(query);
		try {
			return result(await postgres.query(query.text, [...query.values]));
		} catch (error) {
			return failure(error);
		}
	},
	transaction: async (raw) => {
		calls.transaction += 1;
		const queries = raw as CustomerDatabaseQuery[];
		expect(queries.length).toBeLessThanOrEqual(25);
		if (beforeSave) {
			// Something changes between the request's reads and its first write.
			const change = beforeSave;
			beforeSave = undefined;
			await change();
		}
		statements.push(...queries);
		try {
			return await postgres.transaction(async (transaction) => {
				const results = [];
				for (const query of queries)
					results.push(result(await transaction.query(query.text, [...query.values])));
				return results;
			});
		} catch (error) {
			return failure(error);
		}
	},
};
const bucket = {
	get: async (key: string) => {
		calls.files += 2;
		const bytes = objects.get(key);
		await beforeGet?.();
		return bytes ? { arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
	},
	put: async (key: string, bytes: Uint8Array) => {
		calls.files += 3;
		expect(
			(await postgres.query("SELECT r2_key FROM envelope_artifact_versions WHERE r2_key=$1", [key]))
				.rows,
		).toHaveLength(1);
		await beforePut?.();
		if (tombstones.has(key)) throw new Error("Immutable upload was erased");
		objects.set(key, Uint8Array.from(bytes));
	},
	delete: async (keys: string | string[]) => {
		calls.files += 1;
		if (failErasure) throw new Error("Erasure still pending");
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			tombstones.add(key);
			objects.delete(key);
		}
	},
} as unknown as R2Bucket;
const env = {
	DOCUMENTS_BUCKET: bucket,
	CLOUDFLARE_ENV: "production",
	OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	OHMYHOST_MAIL_GATEWAY_URL: "https://private-mail.example.com",
	OHMYHOST_MAIL_KEY: "m".repeat(43),
	SIGN_FROM_EMAIL: "contracts@mail.example.com",
	SIGN_REPLY_TO_EMAIL: "owner@example.com",
	OHMYHOST_MAIL_GATEWAY: {
		fetch: async () => {
			calls.mail += 1;
			await beforeMail?.();
			if (mailAnswer) return mailAnswer();
			return Response.json(
				{
					state: "accepted",
					request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
					message_id: "fixture-message",
				},
				{ status: 202 },
			);
		},
	},
} as unknown as Env;
function request(path: string, init: RequestInit = {}) {
	return withDatabase({ OHMYHOST_DATABASE: binding }, async () =>
		apiHono.request(path, { ...init, headers: { "x-now": now, ...init.headers } }, env),
	);
}
function resetCalls() {
	calls = { query: 0, transaction: 0, files: 0, mail: 0 };
	statements = [];
}
function count() {
	return calls.query + calls.transaction + calls.files + calls.mail;
}
function complete(rememberSignature = false) {
	return request(`/api/signing/${token}/complete`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ signatureName: "Ada Lovelace", rememberSignature }),
	});
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
	await postgres.exec("TRUNCATE envelopes CASCADE");
	tombstones = new Set();
	failErasure = false;
	beforeMail = undefined;
	beforeSave = undefined;
	mailAnswer = undefined;
	beforePut = undefined;
	beforeGet = undefined;
	const pdf = await PDFDocument.create();
	pdf.setCreationDate(new Date(now));
	pdf.setModificationDate(new Date(now));
	pdf.addPage([612, 792]);
	const bytes = await pdf.save({ useObjectStreams: false });
	objects = new Map([["source/v1.pdf", bytes]]);
	await postgres.query(
		"INSERT INTO envelopes(id,created_by,status) VALUES($1,'owner@example.com','sent')",
		[envelopeId],
	);
	await postgres.query(
		"INSERT INTO envelope_recipients(id,envelope_id,name,email,status) VALUES($1,$2,'Ada Lovelace','ada@example.com','sent')",
		[recipientId, envelopeId],
	);
	await postgres.query(
		"INSERT INTO signer_tokens(id,envelope_id,recipient_id,token,expires_at,verified_at) VALUES($1,$2,$3,$4,'2026-10-28T14:00:00Z',$5)",
		[tokenId, envelopeId, recipientId, token, now],
	);
	await postgres.query(
		"INSERT INTO source_documents(id,envelope_id,r2_key,sha256,byte_size,content_type,uploaded_by) VALUES($1,$2,'source/v1.pdf',repeat('a',64),$3,'application/pdf','owner@example.com')",
		[sourceId, envelopeId, bytes.length],
	);
	for (const [index, type] of ["signature", "date"].entries())
		await postgres.query(
			"INSERT INTO envelope_fields(envelope_id,recipient_id,type,page,x,y,width,height) VALUES($1,$2,$3,1,72,$4,180,40)",
			[envelopeId, recipientId, type, 600 + index * 55],
		);
	resetCalls();
});

it("keeps the signing context correlated to the exact token across different envelopes", async () => {
	const otherEnvelope = "10000000-0000-4000-8000-000000000002";
	const otherRecipient = "20000000-0000-4000-8000-000000000002";
	await postgres.query(
		"INSERT INTO envelopes(id,created_by,status) VALUES($1,'another@example.com','sent')",
		[otherEnvelope],
	);
	await postgres.query(
		"INSERT INTO envelope_recipients(id,envelope_id,name,email,status) VALUES($1,$2,'Another recipient','another@example.com','sent')",
		[otherRecipient, otherEnvelope],
	);
	await postgres.query(
		"INSERT INTO envelope_fields(envelope_id,recipient_id,type,page,x,y,width,height) VALUES($1,$2,'signature',1,72,100,180,20)",
		[otherEnvelope, otherRecipient],
	);
	await postgres.query(
		"INSERT INTO audit_events(envelope_id,event_type) VALUES($1,'envelope.deletion_started')",
		[otherEnvelope],
	);
	const resolved = await withDatabase({ OHMYHOST_DATABASE: binding }, () =>
		resolveSignerToken(token, { completion: true }),
	);
	expect(resolved?.completionContext?.envelope.id).toBe(envelopeId);
	expect(resolved?.deletionPending).toBe(false);
	expect(resolved?.completionContext?.fields).toHaveLength(2);
	expect(resolved?.completionContext?.recipients.map((recipient) => recipient.id)).toEqual([
		recipientId,
	]);
	expect(calls).toEqual({ query: 1, transaction: 0, files: 0, mail: 0 });
});

it.each([
	"source-pdf",
	"final-pdf",
])("closes the recipient %s response if deletion starts during file read", async (path) => {
	if (path === "final-pdf") expect((await complete()).status).toBe(200);
	beforeGet = async () => {
		await postgres.query(
			"INSERT INTO audit_events(envelope_id,event_type) VALUES($1,'envelope.deletion_started')",
			[envelopeId],
		);
	};
	resetCalls();
	const response = await request(`/api/signing/${token}/${path}`);
	expect(response.status).toBe(410);
	expect(count()).toBeLessThanOrEqual(10);
});

it.each([
	false,
	true,
])("keeps real SQL recipient requests inside ten private calls including remembered signature=%s", async (remember) => {
	for (let index = 0; index < 18; index += 1)
		await postgres.query(
			"INSERT INTO envelope_fields(envelope_id,recipient_id,type,page,x,y,width,height) VALUES($1,$2,'signature',1,72,$3,180,20)",
			[envelopeId, recipientId, 100 + index * 20],
		);
	for (const path of [
		`/api/signing/verifications/${token}`,
		`/api/signing/${token}`,
		`/api/signing/${token}/source-pdf`,
	]) {
		resetCalls();
		expect((await request(path)).status).toBe(200);
		expect(count()).toBeLessThanOrEqual(10);
	}
	resetCalls();
	const response = await complete(remember);
	expect(await response.json()).toMatchObject({ data: { envelopeStatus: "completed" } });
	expect(response.status).toBe(200);
	expect(calls).toEqual({ query: 1, transaction: 3, files: 5, mail: 1 });
	expect(count()).toBe(10);
	expect(statements.every((query) => query.values.length <= 100)).toBe(true);
	expect((await postgres.query("SELECT status FROM envelopes")).rows).toEqual([
		{ status: "completed" },
	]);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM signature_profiles")).rows,
	).toEqual([{ count: remember ? 1 : 0 }]);
	for (const path of [
		`/api/signing/${token}`,
		`/api/final-documents/${token}`,
		`/api/final-documents/${token}/pdf`,
	]) {
		resetCalls();
		expect((await request(path)).status).toBe(200);
		expect(count()).toBeLessThanOrEqual(10);
	}
});

it.each([
	"token-before-save",
	"owner-before-save",
	"expired-before-save",
	"token-before-commit",
	"owner-before-commit",
	"expired-before-commit",
])("preserves the current authority and lifecycle across external awaits: %s", async (scenario) => {
	const change = async () => {
		if (scenario.startsWith("token"))
			await postgres.exec("UPDATE signer_tokens SET status='revoked'");
		if (scenario.startsWith("owner"))
			await postgres.exec("UPDATE envelopes SET created_by='another@example.com'");
		if (scenario.startsWith("expired"))
			await postgres.exec("UPDATE envelopes SET status='expired'");
	};
	if (scenario.endsWith("save")) beforeSave = change;
	else beforePut = change;
	const response = await complete(true);
	expect(response.status).toBe(scenario.endsWith("save") ? 409 : 503);
	expect(count()).toBeLessThanOrEqual(10);
	expect((await postgres.query("SELECT * FROM final_documents")).rows).toEqual([]);
	expect((await postgres.query("SELECT status FROM envelopes")).rows[0]).not.toEqual({
		status: "completed",
	});
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM field_values")).rows,
	).toEqual([{ count: scenario.endsWith("save") ? 0 : 2 }]);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM signature_profiles")).rows,
	).toEqual([{ count: scenario.endsWith("save") ? 0 : 1 }]);
});

it.each([
	"before-manifest",
	"after-manifest",
	"failed-erasure",
])("fences final upload and every recipient read with retryable deletion intent: %s", async (scenario) => {
	const erase = async () => {
		const originalCalls = calls;
		const originalStatements = statements;
		resetCalls();
		try {
			await withDatabase({ OHMYHOST_DATABASE: binding }, () =>
				controlEnvelope(envelopeId, "owner@example.com", "delete", { documentsBucket: bucket }),
			);
			expect(count()).toBeLessThanOrEqual(10);
		} finally {
			calls = originalCalls;
			statements = originalStatements;
		}
	};
	if (scenario === "before-manifest") beforeSave = erase;
	if (scenario === "after-manifest") beforePut = erase;
	if (scenario === "failed-erasure") {
		failErasure = true;
		await expect(erase()).rejects.toThrow("Erasure still pending");
		expect((await postgres.query("SELECT status FROM envelopes")).rows).toEqual([
			{ status: "sent" },
		]);
		for (const path of [
			`/api/signing/${token}`,
			`/api/signing/${token}/source-pdf`,
			`/api/signing/${token}/final-pdf`,
			`/api/final-documents/${token}/pdf`,
		]) {
			resetCalls();
			expect([404, 410]).toContain((await request(path)).status);
			expect(calls.files).toBe(0);
		}
		failErasure = false;
		await erase();
	} else {
		const response = await complete();
		expect([409, 503]).toContain(response.status);
		expect(count()).toBeLessThanOrEqual(10);
	}
	expect(
		(
			await postgres.query(
				"SELECT count(*)::integer AS count FROM audit_events WHERE event_type='envelope.deletion_started'",
			)
		).rows,
	).toEqual([{ count: 1 }]);
	expect((await postgres.query("SELECT * FROM final_documents")).rows).toEqual([]);
	expect((await postgres.query("SELECT status FROM envelopes")).rows).toEqual([
		{ status: "deleted" },
	]);
	expect(objects.size).toBe(0);
	if (scenario === "after-manifest")
		expect([...tombstones].some((key) => key.includes("/final/"))).toBe(true);
});

it.each([
	"success",
	"delete",
	"revoke",
])("repairs a retained legacy PDF with ten calls and current download authority: %s", async (scenario) => {
	expect((await complete()).status).toBe(200);
	const document = (await postgres.query<{ id: string }>("SELECT id FROM final_documents")).rows[0];
	if (!document) throw new Error("Final artifact fixture missing");
	const legacy = objects.get("source/v1.pdf");
	if (!legacy) throw new Error("Source artifact fixture missing");
	objects.set("legacy.pdf", legacy);
	await postgres.query("UPDATE final_documents SET r2_key='legacy.pdf' WHERE id=$1", [document.id]);
	beforePut = async () => {
		if (scenario === "revoke") await postgres.exec("UPDATE signer_tokens SET status='revoked'");
		if (scenario === "delete") {
			const outerCalls = calls;
			const outerStatements = statements;
			resetCalls();
			await withDatabase({ OHMYHOST_DATABASE: binding }, () =>
				controlEnvelope(envelopeId, "owner@example.com", "delete", { documentsBucket: bucket }),
			);
			expect(count()).toBeLessThanOrEqual(10);
			calls = outerCalls;
			statements = outerStatements;
		}
	};
	resetCalls();
	const response = await request(`/api/final-documents/${token}/pdf`);
	expect(response.status).toBe(scenario === "success" ? 200 : 503);
	expect(count()).toBeLessThanOrEqual(10);
	if (scenario === "success") {
		expect(count()).toBe(10);
		expect(
			(
				await PDFDocument.load(await response.arrayBuffer(), { updateMetadata: false })
			).getProducer(),
		).toBe("amerged-sign-final-pdf-renderer/4");
	} else {
		expect((await postgres.query("SELECT r2_key FROM final_documents")).rows).toEqual([
			{ r2_key: "legacy.pdf" },
		]);
		if (scenario === "delete") expect(objects.size).toBe(0);
	}
});

it("retries one retained signature after a failed upload without replacing consent or exceeding the call budget", async () => {
	const keys: string[] = [];
	beforePut = async () => {
		throw new Error("Upload uncertain");
	};
	const first = await complete(true);
	expect(first.status).toBe(503);
	expect(count()).toBeLessThanOrEqual(10);
	keys.push(
		...(
			await postgres.query<{ r2_key: string }>("SELECT r2_key FROM envelope_artifact_versions")
		).rows.map((row) => row.r2_key),
	);
	resetCalls();
	const altered = await request(`/api/signing/${token}/complete`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ signatureName: "Different signer", rememberSignature: true }),
	});
	expect(altered.status).toBe(409);
	expect(calls.files).toBe(0);
	beforePut = undefined;
	resetCalls();
	expect((await complete(true)).status).toBe(200);
	expect(count()).toBeLessThanOrEqual(10);
	expect(
		(
			await postgres.query<{ r2_key: string }>("SELECT r2_key FROM envelope_artifact_versions")
		).rows.map((row) => row.r2_key),
	).toEqual(keys);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM field_values")).rows,
	).toEqual([{ count: 2 }]);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM signature_profiles")).rows,
	).toEqual([{ count: 1 }]);
});

it("does not let an old signing link decline an already completed contract", async () => {
	expect((await complete()).status).toBe(200);
	resetCalls();
	const response = await request(`/api/signing/${token}/decline`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ reason: "Cannot replace a retained signature" }),
	});
	expect(response.status).toBe(409);
	expect(count()).toBeLessThanOrEqual(10);
	expect((await postgres.query("SELECT status FROM envelopes")).rows).toEqual([
		{ status: "completed" },
	]);
	expect((await postgres.query("SELECT status FROM envelope_recipients")).rows).toEqual([
		{ status: "completed" },
	]);
});

const mailRefusals: Array<[string, number, string]> = [
	["daily send limit", 429, "mail_send_daily_limit"],
	["suspended sender", 423, "mail_reputation_suspended"],
	["unpaid workspace", 402, "paid_plan_required"],
	["gateway outage", 503, "mail_gateway_unavailable"],
];

it.each(
	mailRefusals,
)("stores the signature and the final PDF although the owner mail is refused: %s", async (_name, status, code) => {
	mailAnswer = () => Response.json({ code }, { status });
	const response = await complete();
	expect(await response.json()).toMatchObject({ data: { envelopeStatus: "completed" } });
	expect(response.status).toBe(200);
	expect(calls.mail).toBe(1);
	expect(count()).toBeLessThanOrEqual(10);
	expect((await postgres.query("SELECT status FROM envelopes")).rows).toEqual([
		{ status: "completed" },
	]);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM field_values")).rows,
	).toEqual([{ count: 2 }]);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM final_documents")).rows,
	).toEqual([{ count: 1 }]);
});

it("tells the owner only after the signature and the final PDF are stored", async () => {
	let stored: unknown;
	beforeMail = async () => {
		stored = {
			values: (await postgres.query("SELECT count(*)::integer AS count FROM field_values")).rows,
			documents: (await postgres.query("SELECT count(*)::integer AS count FROM final_documents"))
				.rows,
			envelope: (await postgres.query("SELECT status FROM envelopes")).rows,
		};
	};
	expect((await complete()).status).toBe(200);
	expect(stored).toEqual({
		values: [{ count: 2 }],
		documents: [{ count: 1 }],
		envelope: [{ status: "completed" }],
	});
	expect(calls.mail).toBe(1);
});

it("sends no owner mail for a signature that was not stored", async () => {
	beforeSave = async () => {
		await postgres.exec("UPDATE signer_tokens SET status='revoked'");
	};
	expect((await complete()).status).toBe(409);
	expect(calls.mail).toBe(0);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM field_values")).rows,
	).toEqual([{ count: 0 }]);
	expect(
		(await postgres.query("SELECT count(*)::integer AS count FROM email_send_records")).rows,
	).toEqual([{ count: 0 }]);
});

it("notifies the owner once the retried completion finishes the PDF, never before", async () => {
	beforePut = async () => {
		throw new Error("Upload uncertain");
	};
	expect((await complete()).status).toBe(503);
	expect(calls.mail).toBe(0);
	beforePut = undefined;
	resetCalls();
	expect((await complete()).status).toBe(200);
	expect(calls.mail).toBe(1);
	expect(count()).toBeLessThanOrEqual(10);
});
