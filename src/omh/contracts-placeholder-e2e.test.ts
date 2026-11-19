import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { withDatabase } from "@/db/setup";
import { hashSignerSession } from "@/db/signer-email";
import { apiHono } from "@/hono/api";
import { processContractInvitations } from "./contracts-outbox";

const owner = "owner@example.com";
const token = "signmos_contract_e2e_test_token";
let postgres: PGlite;
let files: Map<string, Uint8Array>;
let mail: string[];

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
		const query = raw as CustomerDatabaseQuery;
		try {
			return result(await postgres.query(query.text, [...query.values]));
		} catch (error) {
			return failure(error);
		}
	},
	transaction: async (raw) => {
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

const bucket = {
	get: async (key: string) => {
		const bytes = files.get(key);
		return bytes ? { arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
	},
	put: async (key: string, bytes: Uint8Array) => {
		files.set(key, Uint8Array.from(bytes));
	},
} as unknown as R2Bucket;

const env = {
	DOCUMENTS_BUCKET: bucket,
	SIGN_ADMIN_EMAILS: owner,
	APP_BASE_URL: "https://sign.example.com",
	CLOUDFLARE_ENV: "production",
	OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	OHMYHOST_MAIL_GATEWAY_URL: "https://private-mail.example.com",
	OHMYHOST_MAIL_KEY: "m".repeat(43),
	SIGN_FROM_EMAIL: "contracts@mail.example.com",
	SIGN_REPLY_TO_EMAIL: owner,
} as unknown as Env;

function request(path: string, init: RequestInit = {}) {
	return withDatabase({ OHMYHOST_DATABASE: binding }, async () => apiHono.request(path, init, env));
}

beforeAll(async () => {
	postgres = new PGlite();
	const migrations = new URL("../../database/omh-migrations/", import.meta.url);
	for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(name, migrations), "utf8"));
}, 20_000);
afterAll(async () => postgres.close());
afterEach(() => vi.unstubAllGlobals());

it("uploads a template, enforces recipient-owned fields, and produces a completed PDF", async () => {
	files = new Map();
	mail = [];
	vi.stubGlobal("fetch", async (input: Request) => {
		const body = (await input.json()) as { to: string };
		mail.push(body.to);
		return Response.json(
			{
				state: "accepted",
				request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
				message_id: crypto.randomUUID(),
			},
			{ status: 202 },
		);
	});
	await postgres.query(
		"INSERT INTO agentic_api_tokens(email,name,token_hash,token_hint,status,active_slot) VALUES($1,'Test',$2,'test','active',1)",
		[owner, await hashAgenticCredential(token)],
	);
	const pdf = await PDFDocument.create();
	const page = pdf.addPage([612, 792]);
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	for (const [index, marker] of [
		"{{1.name}}",
		"{{1.name}}",
		"{{1.sign}}",
		"{{1.note}}",
		"{{2.approved}}",
		"{{2.sign}}",
	].entries())
		page.drawText(marker, { x: 70, y: 700 - index * 70, size: 12, font });
	const form = new FormData();
	form.set(
		"pdf",
		new Blob([Uint8Array.from(await pdf.save()).buffer], { type: "application/pdf" }),
		"contract.pdf",
	);
	form.set(
		"definition",
		JSON.stringify({
			title: "Template",
			recipients: [
				{ index: 1, name: "Ada", email: "ada@example.com" },
				{ index: 2, name: "Grace", email: "grace@example.com" },
			],
			fields: [
				{ recipient: 1, name: "name", type: "text", label: "Name", required: true },
				{ recipient: 1, name: "sign", type: "signature", label: "Signature", required: true },
				{ recipient: 1, name: "note", type: "text", label: "Note", required: false },
				{ recipient: 2, name: "approved", type: "checkbox", label: "Approve", required: true },
				{ recipient: 2, name: "sign", type: "signature", label: "Signature", required: true },
			],
		}),
	);
	const send = () =>
		request("/api/contracts", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "idempotency-key": "e2e-contract" },
			body: form,
		});
	const response = await send();
	const created = (await response.json()) as { data?: { id: string }; error?: unknown };
	expect({ status: response.status, error: created.error }).toEqual({
		status: 202,
		error: undefined,
	});
	const envelopeId = created.data?.id;
	expect(envelopeId).toBeDefined();
	expect(mail).toEqual([]);
	const replay = await send();
	expect(replay.status).toBe(202);
	expect(await replay.json()).toEqual(created);
	expect(mail).toEqual([]);
	await withDatabase({ OHMYHOST_DATABASE: binding }, () => processContractInvitations(env));
	expect([...mail].sort()).toEqual(["ada@example.com", "grace@example.com"]);
	await withDatabase({ OHMYHOST_DATABASE: binding }, () => processContractInvitations(env));
	expect([...mail].sort()).toEqual(["ada@example.com", "grace@example.com"]);
	const rows = (
		await postgres.query<{ token: string; email: string; recipient_id: string }>(
			"SELECT t.token,r.email,r.id AS recipient_id FROM signer_tokens t JOIN envelope_recipients r ON r.id=t.recipient_id WHERE t.envelope_id=$1 ORDER BY r.email",
			[envelopeId],
		)
	).rows;
	const ada = rows[0];
	const grace = rows[1];
	if (!ada || !grace) throw new Error("Missing recipients");
	await postgres.query("UPDATE signer_tokens SET verified_at=now() WHERE envelope_id=$1", [
		envelopeId,
	]);
	const cookies = new Map<string, string>();
	for (const signer of rows) {
		const session = crypto.randomUUID();
		cookies.set(signer.token, `signmos_signer_session=${session}`);
		await postgres.query(
			"INSERT INTO signer_email_sessions(token_id,envelope_id,recipient_id,email,session_hash,expires_at,created_at) SELECT id,envelope_id,recipient_id,$1,$2,now()+interval '1 hour',now() FROM signer_tokens WHERE token=$3",
			[signer.email, await hashSignerSession(session), signer.token],
		);
	}
	const fields = (
		await postgres.query<{ id: string; name: string; recipient_id: string }>(
			"SELECT id,name,recipient_id FROM envelope_fields WHERE envelope_id=$1 ORDER BY page,y",
			[envelopeId],
		)
	).rows;
	const nameFields = fields.filter(
		(field) => field.name === "name" && field.recipient_id === ada.recipient_id,
	);
	const approve = fields.find(
		(field) => field.name === "approved" && field.recipient_id === grace.recipient_id,
	);
	if (nameFields.length !== 2 || !nameFields[0] || !approve)
		throw new Error("Missing template fields");
	const complete = (signer: string, body: object) =>
		request(`/api/signing/${signer}/complete`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: cookies.get(signer) ?? "" },
			body: JSON.stringify(body),
		});
	const missing = await complete(ada.token, { signatureName: "Ada", fieldValues: {} });
	expect(missing.status).toBe(400);
	expect((await postgres.query("SELECT * FROM field_values")).rows).toHaveLength(0);
	const first = await complete(ada.token, {
		signatureName: "Ada",
		fieldValues: { [nameFields[0].id]: "Ada Lovelace" },
	});
	expect(await first.json()).toMatchObject({ data: { envelopeStatus: "sent" } });
	expect(first.status).toBe(200);
	const savedNames = (
		await postgres.query<{ value: string }>(
			"SELECT v.value FROM field_values v JOIN envelope_fields f ON f.id=v.field_id WHERE f.name='name' ORDER BY f.y",
		)
	).rows;
	expect(savedNames.map(({ value }) => value)).toEqual(["Ada Lovelace", "Ada Lovelace"]);
	const wrongRecipient = await complete(grace.token, {
		signatureName: "Grace",
		fieldValues: { [nameFields[0].id]: "Altered", [approve.id]: true },
	});
	expect(wrongRecipient.status).toBe(400);
	const last = await complete(grace.token, {
		signatureName: "Grace",
		fieldValues: { [approve.id]: true },
	});
	const lastBody = await last.json();
	expect({ status: last.status, body: lastBody }).toMatchObject({
		status: 200,
		body: { data: { envelopeStatus: "completed" } },
	});
	const download = await request(`/api/contracts/${envelopeId}/pdf`, {
		headers: { authorization: `Bearer ${token}` },
	});
	expect(download.status).toBe(200);
	const finalBytes = new Uint8Array(await download.arrayBuffer());
	const final = await PDFDocument.load(finalBytes, { updateMetadata: false });
	expect(final.getPageCount()).toBeGreaterThan(1);
	expect(final.getProducer()).toBe("amerged-sign-final-pdf-renderer/4");
	const extracted = await getDocument({ data: finalBytes.slice() }).promise;
	const firstPage = await extracted.getPage(1);
	const text = (await firstPage.getTextContent()).items
		.flatMap((item) => ("str" in item ? [item.str] : []))
		.join(" ");
	expect(text).toContain("Ada Lovelace");
	expect(text).toContain("Grace");
	await extracted.destroy();
}, 30_000);
