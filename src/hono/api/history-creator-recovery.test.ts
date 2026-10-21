import {
	auditEvents,
	emailSendRecords,
	envelopeRecipients,
	envelopes,
	finalDocuments,
	senderVerificationTokens,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { hashHistoryCredential, historySecurityEvents, historySessions } from "@/db/history-access";
import { apiHono } from "@/hono/api";
import { pdfFixtureBytes } from "@/test/pdf-fixtures";

type StoredRow = Record<string, unknown>;

const envelopeId = "00000000-0000-4000-8000-000000000041";
const rawSession = "opaque-creator-history-session";
const senderTokenValue = "sender-token-must-stay-server-side";
const now = "2026-07-17T10:00:00.000Z";

const state = vi.hoisted(() => ({
	tables: new Map<string, unknown>(),
	rows: new Map<unknown, StoredRow[]>(),
	deletedKeys: [] as string[],
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
	const row = rowsFor(table)[0];
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
		["senderTokens", senderVerificationTokens],
		["recipients", envelopeRecipients],
		["signerTokens", signerTokens],
		["sources", sourceDocuments],
		["finals", finalDocuments],
		["auditEvents", auditEvents],
		["emailSends", emailSendRecords],
		["sessions", historySessions],
		["securityEvents", historySecurityEvents],
	]);
	state.rows = new Map();
	for (const table of state.tables.values()) state.rows.set(table, []);
	tableRows("envelopes").push({
		id: envelopeId,
		status: "awaiting_verification",
		signingMode: "me_and_another_signer",
		createdBy: "creator@example.com",
		createdAt: new Date("2026-07-16T08:00:00.000Z"),
		sentBy: null,
		sentAt: null,
	});
	tableRows("senderTokens").push({
		id: "70000000-0000-4000-8000-000000000041",
		envelopeId,
		name: "Ada Creator",
		email: "creator@example.com",
		token: senderTokenValue,
		status: "pending",
		expiresAt: new Date("2026-07-16T09:00:00.000Z"),
		verifiedAt: null,
		createdAt: new Date("2026-07-16T08:01:00.000Z"),
	});
	tableRows("recipients").push({
		id: "20000000-0000-4000-8000-000000000041",
		envelopeId,
		name: "Grace Signer",
		email: "signer@example.com",
		status: "sent",
		createdAt: new Date("2026-07-16T08:02:00.000Z"),
	});
	const sourceKey = `envelopes/${envelopeId}/source-v1.pdf`;
	const finalKey = `envelopes/${envelopeId}/final.pdf`;
	tableRows("sources").push({
		id: "10000000-0000-4000-8000-000000000041",
		envelopeId,
		r2Key: sourceKey,
		version: 1,
		sha256: "a".repeat(64),
		byteSize: pdfFixtureBytes("source").byteLength,
		contentType: "application/pdf",
		originalFilename: "Creator contract.pdf",
		uploadedBy: "creator@example.com",
		uploadedAt: new Date("2026-07-16T08:03:00.000Z"),
	});
	tableRows("finals").push({
		id: "90000000-0000-4000-8000-000000000041",
		envelopeId,
		r2Key: finalKey,
		sha256: "f".repeat(64),
		byteSize: 20,
		contentType: "application/pdf",
		createdAt: new Date("2026-07-16T09:00:00.000Z"),
	});
	state.r2Objects = new Map([
		[sourceKey, pdfFixtureBytes("source")],
		[finalKey, new TextEncoder().encode("%PDF-1.7 final\n%%EOF")],
	]);
	state.deletedKeys = [];
	tableRows("sessions").push({
		id: "40000000-0000-4000-8000-000000000041",
		linkId: "60000000-0000-4000-8000-000000000041",
		email: "creator@example.com",
		sessionHash: await hashHistoryCredential(rawSession),
		status: "active",
		expiresAt: new Date("2026-07-17T18:00:00.000Z"),
		revokedAt: null,
		createdAt: new Date(now),
	});
}

function historyHeaders(extra: Record<string, string> = {}) {
	return { cookie: `signmos_history_session=${rawSession}`, "x-now": now, ...extra };
}

const bucket = {
	get: async (key: string) => {
		const bytes = state.r2Objects.get(key);
		return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
	},
	delete: async (keys: string | string[]) => {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			state.deletedKeys.push(key);
			state.r2Objects.delete(key);
		}
	},
};

describe("history-session creator recovery", () => {
	beforeEach(resetState);

	it("records sender verification equivalence and resumes without exposing the sender token", async () => {
		const response = await apiHono.request(`/api/history/documents/${envelopeId}/creator`, {
			headers: historyHeaders(),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			data: expect.objectContaining({
				envelopeId,
				status: "draft",
				signingMode: "me_and_another_signer",
				sender: { name: "Ada Creator", email: "creator@example.com" },
				allowedActions: ["resume"],
				resumeUrl: `/my-documents/${envelopeId}/manage`,
			}),
		});
		expect(JSON.stringify(body)).not.toContain(senderTokenValue);
		expect(tableRows("envelopes")[0]?.status).toBe("draft");
		expect(tableRows("senderTokens")[0]).toMatchObject({
			status: "verified",
			verifiedAt: new Date(now),
		});
		expect(tableRows("auditEvents")).toEqual(
			expect.arrayContaining([expect.objectContaining({ eventType: "sender.verified" })]),
		);
		expect(tableRows("securityEvents")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					envelopeId,
					eventType: "history.creator.opened",
					sessionId: tableRows("sessions")[0]?.id,
				}),
			]),
		);
	});

	it.each([
		[
			"different email",
			() => Object.assign(tableRows("sessions")[0] ?? {}, { email: "other@example.com" }),
		],
		[
			"signer only",
			() => Object.assign(tableRows("sessions")[0] ?? {}, { email: "signer@example.com" }),
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
	])("denies %s without sender equivalence", async (_label, arrange) => {
		arrange();
		const response = await apiHono.request(`/api/history/documents/${envelopeId}/creator`, {
			headers: historyHeaders(),
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(tableRows("senderTokens")[0]).toMatchObject({ status: "pending", verifiedAt: null });
		expect(tableRows("auditEvents")).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ eventType: "sender.verified" })]),
		);
	});

	it.each([
		["draft", ["resume"]],
		["changes_requested", ["resume", "cancel", "delete"]],
		["sent", ["review", "cancel", "delete"]],
	] as const)("returns tokenless %s resume/status actions", async (status, allowedActions) => {
		Object.assign(tableRows("envelopes")[0] ?? {}, { status });
		Object.assign(tableRows("senderTokens")[0] ?? {}, {
			status: "verified",
			verifiedAt: new Date(now),
		});
		const response = await apiHono.request(`/api/history/documents/${envelopeId}/creator`, {
			headers: historyHeaders(),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			data: expect.objectContaining({
				status,
				allowedActions,
				resumeUrl: `/my-documents/${envelopeId}/manage`,
			}),
		});
		expect(JSON.stringify(body)).not.toContain(senderTokenValue);
	});

	it("reads active preparation resources through the history session marker without a token", async () => {
		Object.assign(tableRows("envelopes")[0] ?? {}, { status: "draft" });
		Object.assign(tableRows("senderTokens")[0] ?? {}, {
			status: "verified",
			verifiedAt: new Date(now),
		});
		const responses = await Promise.all(
			["source-pdf", "recipients", "fields"].map((resource) =>
				apiHono.request(`/api/envelopes/${envelopeId}/${resource}`, {
					headers: historyHeaders({ "x-history-session-access": "true" }),
				}),
			),
		);
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
	});

	it("denies signer controls, CSRF, and a stale cancel state with stable errors", async () => {
		Object.assign(tableRows("envelopes")[0] ?? {}, { status: "sent" });
		Object.assign(tableRows("senderTokens")[0] ?? {}, {
			status: "verified",
			verifiedAt: new Date(now),
		});
		Object.assign(tableRows("sessions")[0] ?? {}, { email: "signer@example.com" });
		const signerOnly = await creatorAction("cancel", "http://localhost");
		expect(signerOnly.status).toBe(403);
		await expect(signerOnly.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "HISTORY_CREATOR_FORBIDDEN" }),
		});

		Object.assign(tableRows("sessions")[0] ?? {}, { email: "creator@example.com" });
		const csrf = await creatorAction("cancel", "https://attacker.example");
		expect(csrf.status).toBe(403);
		Object.assign(tableRows("envelopes")[0] ?? {}, { status: "completed" });
		const stale = await creatorAction("cancel", "http://localhost");
		expect(stale.status).toBe(409);
		await expect(stale.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "HISTORY_CREATOR_ACTION_BLOCKED" }),
		});
	});

	it.each([
		"cancel",
		"delete",
	] as const)("runs confirmed %s exactly once through the existing lifecycle and safe audit", async (action) => {
		Object.assign(tableRows("envelopes")[0] ?? {}, { status: "sent" });
		Object.assign(tableRows("senderTokens")[0] ?? {}, {
			status: "verified",
			verifiedAt: new Date(now),
		});
		const first = await creatorAction(
			action,
			"http://localhost",
			action === "delete" ? bucket : undefined,
		);
		expect(first.status).toBe(200);
		expect(tableRows("envelopes")[0]?.status).toBe(action === "cancel" ? "expired" : "deleted");
		expect(tableRows("auditEvents")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: action === "cancel" ? "envelope.canceled" : "envelope.deleted",
				}),
			]),
		);
		expect(tableRows("securityEvents")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					envelopeId,
					eventType: action === "cancel" ? "history.creator.canceled" : "history.creator.deleted",
				}),
			]),
		);
		expect(
			JSON.stringify([...tableRows("auditEvents"), ...tableRows("securityEvents")]),
		).not.toContain(rawSession);

		const second = await creatorAction(action, "http://localhost");
		expect(second.status).toBeGreaterThanOrEqual(400);
		const domainEvents = tableRows("auditEvents").filter(
			(event) =>
				event.eventType === (action === "cancel" ? "envelope.canceled" : "envelope.deleted"),
		);
		expect(domainEvents).toHaveLength(1);
		if (action === "delete") expect(state.deletedKeys).toHaveLength(2);
	});

	it("revokes creator, source, detail, PDF, status, and mutation paths immediately after delete", async () => {
		Object.assign(tableRows("envelopes")[0] ?? {}, { status: "sent" });
		Object.assign(tableRows("senderTokens")[0] ?? {}, {
			status: "verified",
			verifiedAt: new Date(now),
		});
		const opened = await apiHono.request(`/api/history/documents/${envelopeId}/creator`, {
			headers: historyHeaders(),
		});
		expect(opened.status).toBe(200);
		expect((await creatorAction("delete", "http://localhost", bucket)).status).toBe(200);

		const catalog = await apiHono.request("/api/history/documents", {
			headers: historyHeaders(),
		});
		const responses = await Promise.all([
			apiHono.request(`/api/history/documents/${envelopeId}/creator`, {
				headers: historyHeaders(),
			}),
			apiHono.request(`/api/history/documents/${envelopeId}`, { headers: historyHeaders() }),
			apiHono.request(
				`/api/history/documents/${envelopeId}/pdf`,
				{ headers: historyHeaders() },
				{ DOCUMENTS_BUCKET: bucket },
			),
			apiHono.request(`/api/envelopes/${envelopeId}/source-pdf`, {
				headers: historyHeaders({ "x-history-session-access": "true" }),
			}),
			apiHono.request(`/api/history/documents/${envelopeId}/signing`, {
				headers: historyHeaders(),
			}),
			creatorAction("cancel", "http://localhost"),
			creatorAction("delete", "http://localhost"),
		]);
		expect(catalog.status).toBe(200);
		await expect(catalog.json()).resolves.toEqual({
			data: expect.objectContaining({ items: [] }),
		});
		expect(responses.map((response) => response.status)).toEqual([
			410, 404, 404, 410, 404, 410, 410,
		]);
	});

	it("keeps the existing sender verification and sender-session link contracts", async () => {
		Object.assign(tableRows("senderTokens")[0] ?? {}, {
			status: "verified",
			verifiedAt: new Date(now),
			expiresAt: new Date("2026-07-18T10:00:00.000Z"),
		});
		Object.assign(tableRows("envelopes")[0] ?? {}, { status: "draft" });
		const verification = await apiHono.request(
			`/api/envelopes/sender-verifications/${senderTokenValue}`,
			{
				headers: { "x-now": now },
			},
		);
		const session = await apiHono.request(`/api/envelopes/${envelopeId}/sender-session`, {
			headers: { "x-sender-session-token": senderTokenValue, "x-now": now },
		});
		expect([verification.status, session.status]).toEqual([200, 200]);
		expect(await verification.json()).toEqual({
			data: expect.objectContaining({ senderSessionToken: senderTokenValue }),
		});
	});
});

async function creatorAction(
	action: "cancel" | "delete",
	origin: string,
	documentsBucket?: typeof bucket,
) {
	return apiHono.request(
		`/api/history/documents/${envelopeId}/creator-actions`,
		{
			method: "POST",
			headers: historyHeaders({ origin, "content-type": "application/json" }),
			body: JSON.stringify({ action }),
		},
		documentsBucket ? { DOCUMENTS_BUCKET: documentsBucket } : undefined,
	);
}
