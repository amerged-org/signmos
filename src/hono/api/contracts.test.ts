import { PDFDocument } from "pdf-lib";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { agenticApiTokens, agenticCommandRecords } from "@/db/agentic-access/table";
import { envelopeArtifactVersions } from "@/db/envelope/artifact-versions";
import { MAX_SOURCE_PDF_BYTES } from "@/db/envelope/pdf-policy-limits";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	finalDocuments,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope/table";
import { hashHistoryCredential } from "@/db/history-access/request";
import { historySessions } from "@/db/history-access/table";
import { createAdminCsrfToken } from "@/omh/auth";
import contractsEndpoint from "./contracts";
import {
	contractRows,
	contractsTestBucket,
	contractsTestState as state,
} from "./contracts-test-db";

vi.mock("@/db/setup", async () => {
	const { getContractsTestDb } = await import("./contracts-test-db");
	return { getDb: getContractsTestDb };
});

const token = "signmos_contract_owner_token";
const owner = "owner@amerged.com";
const baseUrl = "https://sign.amerged.com";
const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
	Response.json({ id: "email-1" }),
);
let payload: {
	title: string;
	recipient: { name: string; email: string };
	pdf: { filename: string; base64: string };
};
let env: Env;

function firstRow(table: unknown): Record<string, unknown> {
	const row = contractRows(table)[0];
	if (!row) throw new Error("Missing expected test row");
	return row;
}

function send(
	body: unknown = payload,
	key = "contract-1",
	headers: Record<string, string> = { authorization: `Bearer ${token}` },
) {
	return contractsEndpoint.fetch(
		new Request(`${baseUrl}/`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json", "idempotency-key": key },
			body: JSON.stringify(body),
		}),
		env,
	);
}
function read(path = "/", authorization = `Bearer ${token}`) {
	return contractsEndpoint.fetch(
		new Request(`${baseUrl}${path}`, { headers: { authorization } }),
		env,
	);
}

describe("owner contract API", () => {
	beforeEach(async () => {
		state.rows = new Map();
		state.queryCalls = 0;
		state.objects.clear();
		fetcher.mockClear();
		fetcher.mockImplementation(async () => Response.json({ id: "email-1" }));
		vi.stubGlobal("fetch", fetcher);
		contractRows(agenticApiTokens).push({
			id: crypto.randomUUID(),
			email: owner,
			name: "Owner integration",
			tokenHash: await hashAgenticCredential(token),
			tokenHint: "signmos_...oken",
			status: "active",
			activeSlot: 1,
			createdAt: state.now,
			lastUsedAt: null,
		});
		const pdf = await PDFDocument.create();
		pdf.addPage([612, 792]);
		payload = {
			title: "Beratungsvertrag",
			recipient: { name: "Ada Lovelace", email: "ada@example.com" },
			pdf: { filename: "vertrag.pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
		};
		env = {
			SIGN_ADMIN_EMAILS: owner,
			APP_BASE_URL: baseUrl,
			RESEND_API_KEY: "test-mail-key",
			RESEND_FROM_EMAIL: "Sign <sign@amerged.com>",
			RESEND_REPLY_TO_EMAIL: owner,
			DOCUMENTS_BUCKET: contractsTestBucket(),
		} as Env;
	});
	afterEach(() => vi.unstubAllGlobals());

	it("uploads, prepares and sends one external contract without signing for the owner", async () => {
		fetcher.mockImplementation(async () => {
			expect(firstRow(envelopes).status).toBe("draft");
			expect(firstRow(signerTokens).status).toBe("revoked");
			expect(firstRow(agenticCommandRecords)).toMatchObject({
				state: "pending",
				documentId: firstRow(envelopes).id,
			});
			expect(firstRow(envelopeArtifactVersions).r2Key).toBe(firstRow(sourceDocuments).r2Key);
			return Response.json({ id: "email-1" });
		});
		const response = await send();
		expect(state.queryCalls).toBeLessThanOrEqual(6);
		expect(response.status).toBe(201);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		const body = await response.json();
		expect(body).toEqual({
			data: expect.objectContaining({
				title: payload.title,
				status: "sent",
				recipients: [
					{ name: payload.recipient.name, email: payload.recipient.email, status: "sent" },
				],
				completedAt: null,
				downloadUrl: null,
			}),
		});
		expect(contractRows(envelopes)).toHaveLength(1);
		expect(contractRows(envelopes)[0]?.createdBy).toBe(owner);
		expect(contractRows(envelopeRecipients)).toHaveLength(1);
		expect(contractRows(envelopeFields).map((row) => row.type)).toEqual(["signature", "date"]);
		expect(contractRows(signerTokens)).toHaveLength(1);
		expect(firstRow(signerTokens).status).toBe("active");
		expect(firstRow(agenticCommandRecords)).toMatchObject({
			state: "completed",
			documentId: firstRow(envelopes).id,
			responseStatus: 201,
			responseBody: JSON.stringify(body),
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const emailRequest = fetcher.mock.calls[0];
		expect(JSON.stringify(emailRequest)).toContain(
			"https://sign.amerged.com/signing-verifications/",
		);
		expect(JSON.stringify(body)).not.toContain("token");
		const source = contractRows(sourceDocuments)[0];
		const bytes = state.objects.get(String(source?.r2Key));
		expect(bytes).toBeDefined();
		expect((await PDFDocument.load(bytes ?? new Uint8Array())).getPageCount()).toBe(2);
	});

	it("replays identical requests and rejects changed reuse without another email", async () => {
		const first = await send();
		const original = await first.json();
		const second = await send();
		expect(second.status).toBe(201);
		await expect(second.json()).resolves.toEqual(original);
		const changed = await send({ ...payload, title: "Changed" });
		expect(changed.status).toBe(409);
		await expect(changed.json()).resolves.toMatchObject({
			error: { code: "IDEMPOTENCY_CONFLICT" },
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(contractRows(envelopes)).toHaveLength(1);
	});

	it("claims concurrent identical requests before invitation delivery", async () => {
		const replies = await Promise.all([send(), send()]);
		expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
		expect(contractRows(envelopes)).toHaveLength(1);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const finalReplay = await send();
		expect(finalReplay.status).toBe(201);
	});

	it("requires an allowlisted authenticated identity and rejects supplied sender identities", async () => {
		expect((await send(payload, "missing", { "x-internal-user-id": owner })).status).toBe(403);
		firstRow(agenticApiTokens).email = "intruder@example.com";
		expect((await send()).status).toBe(403);
		firstRow(agenticApiTokens).email = owner;
		expect((await send({ ...payload, createdBy: "intruder@example.com" })).status).toBe(400);
		expect(contractRows(envelopes)).toHaveLength(0);
	});

	it("enforces creator ownership for detail and final PDF even with a valid admin token", async () => {
		await send();
		const id = String(contractRows(envelopes)[0]?.id);
		firstRow(envelopes).createdBy = "other-owner@amerged.com";
		firstRow(envelopes).status = "completed";
		expect((await read(`/${id}`)).status).toBe(404);
		expect((await read(`/${id}/pdf`)).status).toBe(404);
		await expect((await read()).json()).resolves.toEqual({ data: [] });
	});

	it("lists owned contracts and streams a completed PDF with private cache headers", async () => {
		const createResponse = await send();
		const created = (await createResponse.json()) as { data: { id: string } };
		const id = created.data.id;
		expect((await read(`/${id}/pdf`)).status).toBe(409);
		firstRow(envelopes).status = "completed";
		const key = `envelopes/${id}/final.pdf`;
		const bytes = new TextEncoder().encode("%PDF-final-contract");
		state.objects.set(key, bytes);
		contractRows(finalDocuments).push({
			id: crypto.randomUUID(),
			envelopeId: id,
			r2Key: key,
			createdAt: state.now,
			contentType: "application/pdf",
		});
		const list = await (await read()).json();
		expect(list).toEqual({
			data: [
				expect.objectContaining({
					id,
					downloadUrl: `/api/contracts/${id}/pdf`,
					completedAt: state.now.toISOString(),
				}),
			],
		});
		const response = await read(`/${id}/pdf`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	it("denies an owner PDF response when deletion starts during the private file read", async () => {
		await send();
		const id = String(firstRow(envelopes).id);
		firstRow(envelopes).status = "completed";
		const key = `envelopes/${id}/final/retained.pdf`;
		state.objects.set(key, new TextEncoder().encode("%PDF-deletion-fixture"));
		contractRows(finalDocuments).push({
			id: crypto.randomUUID(),
			envelopeId: id,
			r2Key: key,
			createdAt: state.now,
		});
		const bucket = contractsTestBucket();
		const get = bucket.get.bind(bucket);
		vi.spyOn(bucket, "get").mockImplementation(async (file: string) => {
			contractRows(auditEvents).push({
				envelopeId: id,
				eventType: "envelope.deletion_started",
				createdAt: state.now,
			});
			return get(file);
		});
		env.DOCUMENTS_BUCKET = bucket;
		expect((await read(`/${id}/pdf`)).status).toBe(404);
	});

	it("keeps contract reads within four RPCs and PDF readback within five including Bearer authentication", async () => {
		await send();
		const id = String(firstRow(envelopes).id);
		firstRow(envelopes).status = "completed";
		const key = `envelopes/${id}/final/immutable.pdf`;
		state.objects.set(key, new TextEncoder().encode("%PDF-budget-fixture"));
		contractRows(finalDocuments).push({
			id: crypto.randomUUID(),
			envelopeId: id,
			r2Key: key,
			createdAt: state.now,
		});
		for (const path of ["/", `/${id}`, `/${id}/pdf`]) {
			state.queryCalls = 0;
			expect((await read(path)).status).toBe(200);
			expect(state.queryCalls, path).toBeLessThanOrEqual(path.endsWith("/pdf") ? 5 : 4);
		}
	});

	it("supports CSRF-protected cookie requests with durable browser idempotency", async () => {
		const session = crypto.randomUUID();
		contractRows(historySessions).push({
			id: crypto.randomUUID(),
			linkId: crypto.randomUUID(),
			sessionHash: await hashHistoryCredential(session),
			email: owner,
			status: "active",
			expiresAt: new Date(Date.now() + 60_000),
		});
		const headers = {
			cookie: `signmos_history_session=${session}`,
			origin: baseUrl,
			"x-csrf-token": await createAdminCsrfToken(session),
		};
		expect((await send(payload, "browser", { cookie: headers.cookie })).status).toBe(403);
		const first = await send(payload, "browser", headers);
		expect(first.status).toBe(201);
		const replay = await send(payload, "browser", headers);
		await expect(replay.json()).resolves.toEqual(await first.json());
		expect(contractRows(agenticApiTokens).filter((row) => row.status === "internal")).toHaveLength(
			1,
		);
		expect(contractRows(agenticCommandRecords)).toHaveLength(1);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("never silently reports sent when email is unavailable and caches delivery failures", async () => {
		const noMail = { ...env, RESEND_API_KEY: "" };
		const unavailable = await contractsEndpoint.fetch(
			new Request(`${baseUrl}/`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"idempotency-key": "no-mail",
				},
				body: JSON.stringify(payload),
			}),
			noMail,
		);
		expect(unavailable.status).toBe(503);
		expect(contractRows(envelopes)).toHaveLength(0);
		fetcher.mockImplementation(async () => new Response("provider failure", { status: 502 }));
		const failed = await send();
		expect(failed.status).toBe(502);
		expect((await send()).status).toBe(502);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(firstRow(envelopes).status).toBe("draft");
		expect(firstRow(signerTokens).status).toBe("revoked");
		expect(
			contractRows(agenticCommandRecords).find((row) => row.responseStatus === 502)?.documentId,
		).toBe(firstRow(envelopes).id);
	});

	it("never activates an invitation after the draft owner, status or durable claim changes during delivery", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			for (const change of ["owner", "status", "claim"] as const) {
				fetcher.mockImplementation(async () => {
					if (change === "owner") firstRow(envelopes).createdBy = "other-owner@amerged.com";
					if (change === "status") firstRow(envelopes).status = "expired";
					if (change === "claim") firstRow(agenticCommandRecords).state = "completed";
					return Response.json({ id: "email-1" });
				});
				expect((await send(payload, `race-${change}`)).status).toBe(500);
				expect(firstRow(signerTokens).status).toBe("revoked");
				expect(contractRows(emailSendRecords)).toHaveLength(0);
				for (const table of [
					envelopes,
					sourceDocuments,
					envelopeFields,
					envelopeRecipients,
					signerTokens,
					envelopeArtifactVersions,
					agenticCommandRecords,
				])
					state.rows.delete(table);
			}
		} finally {
			logged.mockRestore();
		}
	});

	it("rejects PDFs above 2 MiB and more than 20 fields before creating a draft", async () => {
		const oversized = new Uint8Array(MAX_SOURCE_PDF_BYTES + 1).fill(32);
		oversized.set(new TextEncoder().encode("%PDF-1.7"));
		const response = await send(
			{ ...payload, pdf: { ...payload.pdf, base64: Buffer.from(oversized).toString("base64") } },
			"too-large",
		);
		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "SOURCE_PDF_TOO_LARGE" },
		});
		const fields = Array.from({ length: 21 }, (_, index) => ({
			type: index === 0 ? "signature" : "date",
			page: 1,
			x: 72,
			y: 320,
			width: 180,
			height: 32,
		}));
		const tooManyFields = await send({ ...payload, fields }, "too-many-fields");
		expect(tooManyFields.status).toBe(413);
		await expect(tooManyFields.json()).resolves.toMatchObject({
			error: { code: "SOURCE_PDF_TOO_MANY_FIELDS" },
		});
		expect(contractRows(envelopes)).toHaveLength(0);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects missing idempotency keys, invalid PDF, and self recipient before sending", async () => {
		expect((await send(payload, "")).status).toBe(400);
		const badPdf = await send(
			{
				...payload,
				pdf: { filename: "bad.pdf", base64: Buffer.from("%PDF-invalid").toString("base64") },
			},
			"bad-pdf",
		);
		expect(badPdf.status).toBe(400);
		expect(
			(await send({ ...payload, recipient: { name: "Owner", email: owner } }, "self")).status,
		).toBe(400);
		expect(contractRows(envelopes)).toHaveLength(0);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
