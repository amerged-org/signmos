import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { PDFDocument } from "pdf-lib";
import { withDatabase } from "@/db/setup";
import { apiHono } from "@/hono/api";
import { setOmhMailTransport } from "@/omh/mail";

// The public final-PDF download serves the stored object as the legal artifact. These tests run
// the real routes and the real completion against PostgreSQL (PGlite) and an in-memory file port
// that counts every private call, so a repair has to stay within the Worker's ten subrequests.
const envelopeId = "10000000-0000-4000-8000-000000000001";
const recipientId = "20000000-0000-4000-8000-000000000001";
const tokenId = "30000000-0000-4000-8000-000000000001";
const sourceId = "40000000-0000-4000-8000-000000000001";
const token = "signer-private-test-token";
const now = "2026-10-21T14:00:00Z";
const sourceKey = "source/v1.pdf";
let postgres: PGlite;
let objects: Map<string, Uint8Array>;
let calls: { query: number; transaction: number; files: number; mail: number };

type FinalRow = { id: string; r2_key: string; byte_size: number; sha256: string };

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
		return bytes ? { arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
	},
	put: async (key: string, bytes: Uint8Array) => {
		calls.files += 3;
		expect(
			(await postgres.query("SELECT r2_key FROM envelope_artifact_versions WHERE r2_key=$1", [key]))
				.rows,
		).toHaveLength(1);
		// The platform's upload is create-only: a second upload under the same logical name replays
		// the first one (src/omh/storage.ts) and never replaces what is stored.
		if (!objects.has(key)) objects.set(key, Uint8Array.from(bytes));
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
} as unknown as Env;
async function mailGateway(): Promise<Response> {
	calls.mail += 1;
	return Response.json(
		{
			state: "accepted",
			request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
			message_id: "fixture-message",
		},
		{ status: 202 },
	);
}
function request(path: string, init: RequestInit = {}) {
	return withDatabase({ OHMYHOST_DATABASE: binding }, async () =>
		apiHono.request(path, { ...init, headers: { "x-now": now, ...init.headers } }, env),
	);
}
function resetCalls() {
	calls = { query: 0, transaction: 0, files: 0, mail: 0 };
}
function count() {
	return calls.query + calls.transaction + calls.files + calls.mail;
}
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
async function finalRow(): Promise<FinalRow> {
	const row = (
		await postgres.query<FinalRow>("SELECT id, r2_key, byte_size, sha256 FROM final_documents")
	).rows[0];
	if (!row) throw new Error("Final document fixture missing");
	return row;
}
async function completeEnvelope(): Promise<{ row: FinalRow; stored: Uint8Array }> {
	const completion = await request(`/api/signing/${token}/complete`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ signatureName: "Ada Lovelace", rememberSignature: false }),
	});
	expect(completion.status).toBe(200);
	const row = await finalRow();
	const stored = objects.get(row.r2_key);
	if (!stored) throw new Error("Final artifact fixture missing");
	return { row, stored: Uint8Array.from(stored) };
}
async function downloadFinalPdf(): Promise<Response> {
	resetCalls();
	return request(`/api/final-documents/${token}/pdf`);
}

beforeAll(async () => {
	setOmhMailTransport(mailGateway);
	postgres = new PGlite();
	const migrations = new URL("../../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(file, migrations), "utf8"));
}, 20_000);
afterAll(async () => {
	setOmhMailTransport(null);
	await postgres.close();
});
beforeEach(async () => {
	await postgres.exec("TRUNCATE envelopes CASCADE");
	const pdf = await PDFDocument.create();
	pdf.setCreationDate(new Date(now));
	pdf.setModificationDate(new Date(now));
	pdf.addPage([612, 792]);
	const bytes = await pdf.save({ useObjectStreams: false });
	objects = new Map([[sourceKey, bytes]]);
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
		"INSERT INTO source_documents(id,envelope_id,r2_key,sha256,byte_size,content_type,uploaded_by) VALUES($1,$2,$3,repeat('a',64),$4,'application/pdf','owner@example.com')",
		[sourceId, envelopeId, sourceKey, bytes.length],
	);
	for (const [index, type] of ["signature", "date"].entries())
		await postgres.query(
			"INSERT INTO envelope_fields(envelope_id,recipient_id,type,page,x,y,width,height) VALUES($1,$2,$3,1,72,$4,180,40)",
			[envelopeId, recipientId, type, 600 + index * 55],
		);
	resetCalls();
});

it("serves an intact current final PDF exactly as stored, without reading the source or uploading", async () => {
	const { row, stored } = await completeEnvelope();
	const response = await downloadFinalPdf();
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("application/pdf");
	expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(stored))).toBe(true);
	expect(await finalRow()).toEqual(row);
	// One stored-object read (2 private calls) and no source read or upload.
	expect(calls.files).toBe(2);
	expect(count()).toBeLessThanOrEqual(10);
});

it("regenerates a final PDF that was cut short although it still carries the renderer marker", async () => {
	const { row, stored } = await completeEnvelope();
	objects.set(row.r2_key, stored.slice(0, stored.byteLength - 20));
	// The platform's upload is create-only, so the damaged object keeps its name and every download
	// has to regenerate the recorded artifact again, always within the ten private calls.
	for (const attempt of [1, 2]) {
		const response = await downloadFinalPdf();
		expect(response.status, `download ${attempt}`).toBe(200);
		const served = new Uint8Array(await response.arrayBuffer());
		expect(served.byteLength).toBe(row.byte_size);
		expect(sha256(served)).toBe(row.sha256);
		expect((await PDFDocument.load(served, { updateMetadata: false })).getPageCount()).toBe(2);
		expect(await finalRow()).toEqual(row);
		expect(count()).toBeLessThanOrEqual(10);
	}
});

it("regenerates a final PDF whose bytes changed without changing their length", async () => {
	const { row, stored } = await completeEnvelope();
	const altered = Uint8Array.from(stored);
	altered[Math.floor(altered.byteLength / 2)] ^= 0xff;
	objects.set(row.r2_key, altered);
	const response = await downloadFinalPdf();
	expect(response.status).toBe(200);
	const served = new Uint8Array(await response.arrayBuffer());
	expect(served.byteLength).toBe(row.byte_size);
	expect(sha256(served)).toBe(row.sha256);
	expect((await PDFDocument.load(served, { updateMetadata: false })).getPageCount()).toBe(2);
	expect(await finalRow()).toEqual(row);
	expect(count()).toBeLessThanOrEqual(10);
});

it("answers repair pending instead of serving a damaged final PDF it cannot regenerate", async () => {
	const { row, stored } = await completeEnvelope();
	objects.set(row.r2_key, stored.slice(0, stored.byteLength - 20));
	objects.delete(sourceKey);
	const response = await downloadFinalPdf();
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		error: { code: "FINAL_PDF_REPAIR_PENDING", retryable: true },
	});
	expect(await finalRow()).toEqual(row);
	expect(count()).toBeLessThanOrEqual(10);
});

it("answers repair pending instead of serving a damaged final PDF when no source record is left to repair it from", async () => {
	const { row, stored } = await completeEnvelope();
	objects.set(row.r2_key, stored.slice(0, stored.byteLength - 20));
	// The application never deletes a source record; only a hand-edited database lacks one. The
	// download must fail closed there, not serve bytes that do not match the recorded hash.
	await postgres.query("DELETE FROM source_documents");
	const response = await downloadFinalPdf();
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		error: { code: "FINAL_PDF_REPAIR_PENDING", retryable: true },
	});
	expect(await finalRow()).toEqual(row);
	expect(count()).toBeLessThanOrEqual(10);
});
