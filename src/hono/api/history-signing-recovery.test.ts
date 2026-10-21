import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	senderVerificationTokens,
	signatureProfiles,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { hashHistoryCredential, historySecurityEvents, historySessions } from "@/db/history-access";
import { apiHono } from "@/hono/api";
import { pdfFixtureBytes } from "@/test/pdf-fixtures";

type StoredRow = Record<string, unknown>;
const envelopeId = "00000000-0000-4000-8000-000000000040";
const recipientId = "20000000-0000-4000-8000-000000000040";
const otherRecipientId = "20000000-0000-4000-8000-000000000041";
const tokenValue = "invitation-token-must-never-reach-history-client";
const rawSession = "opaque-history-session";
const now = "2026-07-17T09:00:00.000Z";
const state = vi.hoisted(() => ({
	tables: new Map<string, unknown>(),
	rows: new Map<unknown, StoredRow[]>(),
	r2Objects: new Map<string, Uint8Array>(),
}));
function rowsFor(table: unknown): StoredRow[] {
	return state.rows.get(table) ?? [];
}
function selectQuery(table: unknown) {
	const load = async () => rowsFor(table);
	return Object.assign(load(), { where: () => ({ limit: load }), limit: load });
}
function updateRows(table: unknown, values: StoredRow): StoredRow[] {
	const rows = rowsFor(table);
	const row = rows[0];
	if (!row) return [];
	Object.assign(row, values);
	return [row];
}
vi.mock("@/db/setup", async () => {
	const { wrapSigningTestDb } = await import("@/db/envelope/signing-test-db");
	return {
		getDb: () =>
			wrapSigningTestDb(
				{
					select: () => ({ from: (table: unknown) => selectQuery(table) }),
					insert: (table: unknown) => ({
						values: (values: StoredRow | StoredRow[]) => ({
							returning: async () => {
								const inserted = (Array.isArray(values) ? values : [values]).map((value) => ({
									id: crypto.randomUUID(),
									createdAt: new Date(now),
									...value,
								}));
								rowsFor(table).push(...inserted);
								return inserted;
							},
						}),
					}),
					update: (table: unknown) => ({
						set: (values: StoredRow) => ({
							where: () => {
								const updated = updateRows(table, values);
								return Object.assign(Promise.resolve([]), { returning: async () => updated });
							},
						}),
					}),
				},
				rowsFor,
			),
	};
});
function tableRows(name: string): StoredRow[] {
	const table = state.tables.get(name);
	if (!table) throw new Error(`Missing test table ${name}`);
	return rowsFor(table);
}
async function resetState() {
	state.tables = new Map<string, unknown>([
		["envelopes", envelopes],
		["recipients", envelopeRecipients],
		["fields", envelopeFields],
		["tokens", signerTokens],
		["sources", sourceDocuments],
		["fieldValues", fieldValues],
		["auditEvents", auditEvents],
		["emailSends", emailSendRecords],
		["signatureProfiles", signatureProfiles],
		["sessions", historySessions],
		["securityEvents", historySecurityEvents],
		["finalDocuments", finalDocuments],
		["senderTokens", senderVerificationTokens],
	]);
	state.rows = new Map();
	for (const table of state.tables.values()) state.rows.set(table, []);
	tableRows("envelopes").push({
		id: envelopeId,
		status: "sent",
		signingMode: "me_and_another_signer",
		createdBy: "creator@example.com",
		createdAt: new Date("2026-07-16T08:00:00.000Z"),
		sentBy: "creator@example.com",
		sentAt: new Date("2026-07-16T08:10:00.000Z"),
	});
	tableRows("recipients").push(
		{
			id: recipientId,
			envelopeId,
			name: "Ada Signer",
			email: "ada@example.com",
			status: "sent",
			createdAt: new Date("2026-07-16T08:01:00.000Z"),
		},
		{
			id: otherRecipientId,
			envelopeId,
			name: "Grace Signer",
			email: "grace@example.com",
			status: "sent",
			createdAt: new Date("2026-07-16T08:02:00.000Z"),
		},
	);
	tableRows("tokens").push({
		id: "30000000-0000-4000-8000-000000000040",
		envelopeId,
		recipientId,
		token: tokenValue,
		status: "active",
		expiresAt: new Date("2026-07-16T09:00:00.000Z"),
		verifiedAt: null,
		createdAt: new Date("2026-07-16T08:05:00.000Z"),
	});
	tableRows("fields").push(
		{
			id: "50000000-0000-4000-8000-000000000040",
			envelopeId,
			recipientId,
			type: "signature",
			page: 1,
			x: 72,
			y: 144,
			width: 180,
			height: 48,
			createdAt: new Date("2026-07-16T08:03:00.000Z"),
		},
		{
			id: "50000000-0000-4000-8000-000000000041",
			envelopeId,
			recipientId: otherRecipientId,
			type: "signature",
			page: 1,
			x: 72,
			y: 220,
			width: 180,
			height: 48,
			createdAt: new Date("2026-07-16T08:04:00.000Z"),
		},
	);
	for (const version of [1, 2]) {
		const key = `envelopes/${envelopeId}/source-v${version}.pdf`;
		const bytes = pdfFixtureBytes(`source-v${version}`);
		tableRows("sources").push({
			id: `10000000-0000-4000-8000-00000000004${version}`,
			envelopeId,
			r2Key: key,
			version,
			sha256: String(version).repeat(64),
			byteSize: bytes.byteLength,
			contentType: "application/pdf",
			originalFilename: `Contract v${version}.pdf`,
			uploadedBy: "creator@example.com",
			uploadedAt: new Date(`2026-07-16T08:0${version}:00.000Z`),
		});
		state.r2Objects.set(key, bytes);
	}
	tableRows("sessions").push({
		id: "40000000-0000-4000-8000-000000000040",
		linkId: "60000000-0000-4000-8000-000000000040",
		email: "ada@example.com",
		sessionHash: await hashHistoryCredential(rawSession),
		status: "active",
		expiresAt: new Date("2026-07-17T17:00:00.000Z"),
		revokedAt: null,
		createdAt: new Date("2026-07-17T09:00:00.000Z"),
	});
}

function historyHeaders(extra: Record<string, string> = {}) {
	return {
		cookie: `signmos_history_session=${rawSession}`,
		"x-now": now,
		...extra,
	};
}

const bucket = {
	get: async (key: string) => {
		const bytes = state.r2Objects.get(key);
		return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
	},
};

describe("history-session signer recovery", () => {
	beforeEach(resetState);

	it("records recipient verification equivalence and opens assigned signing without a bearer", async () => {
		// Assumptions before RED are documented in the #40 implementation update.
		const response = await apiHono.request(`/api/history/documents/${envelopeId}/signing`, {
			headers: historyHeaders(),
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			data: expect.objectContaining({
				envelopeId,
				recipientId,
				sourceDocument: {
					version: 2,
					contentType: "application/pdf",
					downloadUrl: `/api/history/documents/${envelopeId}/signing/source-pdf`,
				},
				fields: [expect.objectContaining({ type: "signature" })],
			}),
		});
		expect(JSON.stringify(body)).not.toContain(tokenValue);
		expect(tableRows("tokens")[0]?.verifiedAt).toEqual(new Date(now));
		expect(tableRows("auditEvents")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "partner.verified", recipientId }),
				expect.objectContaining({ eventType: "partner.signing.viewed", recipientId }),
			]),
		);
	});

	it("serves only the latest source PDF and assigned fields through the live session", async () => {
		const pdf = await apiHono.request(
			`/api/history/documents/${envelopeId}/signing/source-pdf`,
			{ headers: historyHeaders() },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(pdf.status).toBe(200);
		expect(new TextDecoder().decode(await pdf.arrayBuffer())).toContain("source-v2");
		expect(tableRows("securityEvents")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					envelopeId,
					eventType: "history.signer.source_pdf.opened",
					sessionId: tableRows("sessions")[0]?.id,
				}),
			]),
		);
	});

	it("preserves self-sign field placement rules through session authorization", async () => {
		Object.assign(tableRows("envelopes")[0] ?? {}, { signingMode: "only_me" });
		const fieldId = "50000000-0000-4000-8000-000000000040";
		const response = await apiHono.request(
			`/api/history/documents/${envelopeId}/signing/fields/${fieldId}`,
			{
				method: "PATCH",
				headers: historyHeaders({
					origin: "http://localhost",
					"content-type": "application/json",
				}),
				body: JSON.stringify({ page: 1, x: 96, y: 192 }),
			},
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: expect.objectContaining({ id: fieldId, x: 96, y: 192 }),
		});
	});

	it.each([
		[
			"different recipient",
			() => Object.assign(tableRows("sessions")[0] ?? {}, { email: "grace@example.com" }),
		],
		[
			"creator only",
			() => Object.assign(tableRows("sessions")[0] ?? {}, { email: "creator@example.com" }),
		],
		[
			"expired session",
			() => Object.assign(tableRows("sessions")[0] ?? {}, { expiresAt: new Date(now) }),
		],
		["revoked session", () => Object.assign(tableRows("sessions")[0] ?? {}, { status: "revoked" })],
		[
			"deleted envelope",
			() => Object.assign(tableRows("envelopes")[0] ?? {}, { status: "deleted" }),
		],
		[
			"disallowed state",
			() => Object.assign(tableRows("envelopes")[0] ?? {}, { status: "changes_requested" }),
		],
	])("denies %s without verification or signing side effects", async (_label, arrange) => {
		arrange();
		const response = await apiHono.request(`/api/history/documents/${envelopeId}/signing`, {
			headers: historyHeaders(),
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(tableRows("tokens")[0]?.verifiedAt).toBeNull();
		expect(tableRows("fieldValues")).toHaveLength(0);
		expect(tableRows("auditEvents")).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ eventType: "partner.verified" })]),
		);
	});

	it.each([
		"expired",
		"declined",
		"deleted",
	] as const)("returns a closed %s API state with no signing mutation", async (status) => {
		Object.assign(tableRows("envelopes")[0] ?? {}, { status });
		const response = await apiHono.request(`/api/history/documents/${envelopeId}/signing`, {
			headers: historyHeaders(),
		});
		expect(response.status).toBe(410);
		await expect(response.json()).resolves.toEqual({
			error: expect.objectContaining({ code: `HISTORY_SIGNING_${status.toUpperCase()}` }),
		});
		expect(tableRows("fieldValues")).toHaveLength(0);
	});

	it("completes through the shared lifecycle and moves the signer to waiting on others", async () => {
		const response = await apiHono.request(
			`/api/history/documents/${envelopeId}/signing/complete`,
			{
				method: "POST",
				headers: historyHeaders({
					origin: "http://localhost",
					"content-type": "application/json",
				}),
				body: JSON.stringify({
					signature: { kind: "typed", typedText: "Ada Signer", typedFont: "cursive" },
					rememberSignature: false,
				}),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: { envelopeId, recipientId, recipientStatus: "completed", envelopeStatus: "sent" },
		});
		expect(tableRows("fieldValues")).toEqual([
			expect.objectContaining({ recipientId, value: "Ada Signer" }),
		]);
		expect(tableRows("recipients")[0]?.status).toBe("completed");
		expect(tableRows("auditEvents")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "field.value.completed" }),
				expect.objectContaining({ eventType: "recipient.completed" }),
			]),
		);
		expect(tableRows("securityEvents")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ envelopeId, eventType: "history.signer.completed" }),
			]),
		);

		const catalog = await apiHono.request("/api/history/documents", {
			headers: historyHeaders(),
		});
		expect(catalog.status).toBe(200);
		await expect(catalog.json()).resolves.toEqual({
			data: expect.objectContaining({
				items: [expect.objectContaining({ envelopeId, group: "waiting_on_others" })],
			}),
		});
	});

	it.each([
		["change-request", { comment: "Move the signature field" }, "changes_requested"],
		["decline", { reason: "Terms changed", comment: "Please revise" }, "declined"],
	] as const)("preserves the existing %s lifecycle", async (action, input, expectedStatus) => {
		const response = await apiHono.request(
			`/api/history/documents/${envelopeId}/signing/${action}`,
			{
				method: "POST",
				headers: historyHeaders({
					origin: "http://localhost",
					"content-type": "application/json",
				}),
				body: JSON.stringify(input),
			},
		);
		expect(response.status).toBe(200);
		expect(tableRows("envelopes")[0]?.status).toBe(expectedStatus);
	});

	it("requires same-origin mutations and re-authorizes after page-load deletion", async () => {
		const opened = await apiHono.request(`/api/history/documents/${envelopeId}/signing`, {
			headers: historyHeaders(),
		});
		expect(opened.status).toBe(200);
		Object.assign(tableRows("envelopes")[0] ?? {}, { status: "deleted" });

		const source = await apiHono.request(
			`/api/history/documents/${envelopeId}/signing/source-pdf`,
			{ headers: historyHeaders() },
			{ DOCUMENTS_BUCKET: bucket },
		);
		const mutation = await apiHono.request(
			`/api/history/documents/${envelopeId}/signing/complete`,
			{
				method: "POST",
				headers: historyHeaders({
					origin: "https://attacker.example",
					"content-type": "application/json",
				}),
				body: JSON.stringify({ signatureName: "Ada" }),
			},
		);
		const deletedMutation = await apiHono.request(
			`/api/history/documents/${envelopeId}/signing/complete`,
			{
				method: "POST",
				headers: historyHeaders({ origin: "http://localhost", "content-type": "application/json" }),
				body: JSON.stringify({ signatureName: "Ada" }),
			},
		);
		expect(source.status).toBe(410);
		expect(mutation.status).toBe(403);
		expect(deletedMutation.status).toBe(410);
		expect(tableRows("fieldValues")).toHaveLength(0);
	});

	it("keeps the existing verified invitation-link contract unchanged", async () => {
		Object.assign(tableRows("tokens")[0] ?? {}, {
			verifiedAt: new Date("2026-07-16T08:10:00.000Z"),
			expiresAt: new Date("2026-07-18T08:10:00.000Z"),
		});
		const response = await apiHono.request(`/api/signing/${tokenValue}`, {
			headers: { "x-now": now },
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			data: expect.objectContaining({
				sourceDocument: expect.objectContaining({
					downloadUrl: `/api/signing/${tokenValue}/source-pdf`,
				}),
			}),
		});
	});

	it("returns tokenless completed links and audits the history final-PDF download", async () => {
		Object.assign(tableRows("envelopes")[0] ?? {}, { status: "completed" });
		Object.assign(tableRows("recipients")[0] ?? {}, { status: "completed" });
		const finalKey = `envelopes/${envelopeId}/final.pdf`;
		const finalBytes = new TextEncoder().encode("%PDF-1.7 recovered-final\n%%EOF");
		tableRows("finalDocuments").push({
			id: "90000000-0000-4000-8000-000000000040",
			envelopeId,
			r2Key: finalKey,
			sha256: "f".repeat(64),
			byteSize: finalBytes.byteLength,
			contentType: "application/pdf",
			createdAt: new Date(now),
		});
		state.r2Objects.set(finalKey, finalBytes);

		const completed = await apiHono.request(`/api/history/documents/${envelopeId}/signing`, {
			headers: historyHeaders(),
		});
		expect(completed.status).toBe(200);
		const body = await completed.json();
		expect(body).toEqual({
			data: {
				completedDocument: {
					url: `/my-documents/${envelopeId}`,
					downloadUrl: `/api/history/documents/${envelopeId}/pdf`,
				},
			},
		});
		expect(JSON.stringify(body)).not.toContain(tokenValue);

		const pdf = await apiHono.request(
			`/api/history/documents/${envelopeId}/pdf`,
			{ headers: historyHeaders() },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(pdf.status).toBe(200);
		expect(tableRows("securityEvents")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ envelopeId, eventType: "history.final_pdf.downloaded" }),
			]),
		);
		expect(JSON.stringify(tableRows("auditEvents"))).not.toContain(rawSession);

		Object.assign(tableRows("envelopes")[0] ?? {}, { status: "deleted" });
		const staleDetail = await apiHono.request(`/api/history/documents/${envelopeId}`, {
			headers: historyHeaders(),
		});
		const stalePdf = await apiHono.request(
			`/api/history/documents/${envelopeId}/pdf`,
			{ headers: historyHeaders() },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect([staleDetail.status, stalePdf.status]).toEqual([404, 404]);
	});
});
