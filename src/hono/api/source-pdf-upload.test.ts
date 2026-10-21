import {
	auditEvents,
	envelopeFields,
	envelopes,
	idempotencyRecords,
	senderVerificationTokens,
	sourceDocuments,
} from "@/db/envelope";
import { MAX_SOURCE_PDF_BYTES } from "@/db/envelope/pdf-policy";
import { apiHono } from "@/hono/api";
import { pdfFixtureBytes, pdfFixtureText } from "@/test/pdf-fixtures";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	idempotencyTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	senderVerificationTokensTable: null as unknown,
	fieldsTable: null as unknown,
	auditEventsTable: null as unknown,
	envelopes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			status: "draft",
			signingMode: "me_and_another_signer",
			createdBy: "ada@example.com",
			createdAt: new Date("2026-05-21T09:00:00.000Z"),
			sentBy: null,
			sentAt: null,
		},
	] as Array<Record<string, unknown>>,
	idempotencyRecords: [] as Array<Record<string, unknown>>,
	sourceDocuments: [] as Array<Record<string, unknown>>,
	senderVerificationTokens: [
		{
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			token: "verified-sender-token",
			status: "verified",
			expiresAt: new Date("2026-05-21T09:30:00.000Z"),
			verifiedAt: new Date("2026-05-21T09:05:00.000Z"),
			createdAt: new Date("2026-05-21T09:00:00.000Z"),
		},
	] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	fields: [] as Array<Record<string, unknown>>,
	r2Objects: new Map<string, Uint8Array>(),
}));

function selectRows(table: unknown): Array<Record<string, unknown>> {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.idempotencyTable) return state.idempotencyRecords;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.senderVerificationTokensTable) return state.senderVerificationTokens;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.auditEventsTable) return state.auditEvents;
	return [];
}

function insertRows(table: unknown, rows: Array<Record<string, unknown>>) {
	if (table === state.idempotencyTable) {
		state.idempotencyRecords.push(...rows);
		return rows;
	}
	if (table === state.sourceDocumentsTable) {
		const inserted = rows.map((row, index) => ({
			id: `10000000-0000-4000-8000-${String(state.sourceDocuments.length + index + 1).padStart(12, "0")}`,
			uploadedAt: new Date("2026-05-21T09:10:00.000Z"),
			...row,
		}));
		state.sourceDocuments.push(...inserted);
		return inserted;
	}
	if (table === state.auditEventsTable) {
		state.auditEvents.push(...rows);
		return rows;
	}
	return rows;
}

function storeR2Object(key: string, value: ArrayBuffer | ArrayBufferView) {
	const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
	state.r2Objects.set(key, bytes);
}

function updateRows(table: unknown, value: Record<string, unknown>) {
	if (table === state.envelopesTable) {
		state.envelopes = state.envelopes.map((row) => ({ ...row, ...value }));
	}
	return [];
}

function deleteRows(table: unknown) {
	if (table === state.fieldsTable) state.fields.length = 0;
	return [];
}

vi.mock("@/db/setup", () => ({
	getDb: () => ({
		select: () => ({
			from: (table: unknown) => ({
				where: () => ({
					limit: async () => selectRows(table),
				}),
			}),
		}),
		insert: (table: unknown) => ({
			values: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => ({
				returning: async () => insertRows(table, Array.isArray(rows) ? rows : [rows]),
			}),
		}),
		update: (table: unknown) => ({
			set: (value: Record<string, unknown>) => ({
				where: async () => updateRows(table, value),
			}),
		}),
		delete: (table: unknown) => ({
			where: async () => deleteRows(table),
		}),
	}),
}));

describe("source PDF upload API", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.idempotencyTable = idempotencyRecords;
		state.sourceDocumentsTable = sourceDocuments;
		state.senderVerificationTokensTable = senderVerificationTokens;
		state.fieldsTable = envelopeFields;
		state.auditEventsTable = auditEvents;
		state.envelopes[0] = {
			id: "00000000-0000-4000-8000-000000000001",
			status: "draft",
			signingMode: "me_and_another_signer",
			createdBy: "ada@example.com",
			createdAt: new Date("2026-05-21T09:00:00.000Z"),
			sentBy: null,
			sentAt: null,
		};
		state.idempotencyRecords.length = 0;
		state.sourceDocuments.length = 0;
		state.auditEvents.length = 0;
		state.fields.length = 0;
		state.r2Objects.clear();
	});

	it("allows a verified sender session to upload one PDF and records metadata plus audit evidence", async () => {
		// - PDF bytes are stored in R2 and metadata/hash are persisted in the document row.
		// - A successful upload appends an immutable audit event.
		const pdfBytes = pdfFixtureBytes();
		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				method: "POST",
				headers: {
					"x-sender-session-token": "verified-sender-token",
					"x-now": "2026-05-21T09:10:00.000Z",
					"idempotency-key": "source-upload-1",
					"content-type": "application/pdf",
					"x-source-filename": "contract.pdf",
				},
				body: pdfBytes,
			},
			{
				DOCUMENTS_BUCKET: {
					put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
						storeR2Object(key, value);
						return null;
					},
				},
			},
		);

		expect(response.status).toBe(201);
		const body = (await response.json()) as { data: { r2Key: string } };
		expect(body).toEqual({
			data: {
				id: expect.any(String),
				envelopeId: "00000000-0000-4000-8000-000000000001",
				r2Key: expect.stringContaining("source-v1.pdf"),
				version: 1,
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				byteSize: pdfBytes.byteLength,
				contentType: "application/pdf",
				originalFilename: "contract.pdf",
				uploadedBy: "ada@example.com",
				uploadedAt: expect.any(String),
			},
		});
		expect(state.sourceDocuments).toEqual([
			expect.objectContaining({
				r2Key: body.data.r2Key,
				byteSize: pdfBytes.byteLength,
				contentType: "application/pdf",
				originalFilename: "contract.pdf",
				uploadedBy: "ada@example.com",
			}),
		]);
		expect(state.r2Objects.has(body.data.r2Key)).toBe(true);
		expect(state.auditEvents).toEqual([
			expect.objectContaining({
				eventType: "source_pdf.uploaded",
				message: "ada@example.com",
			}),
		]);
	});

	it("returns the persisted source PDF for a verified sender session", async () => {
		state.sourceDocuments.push({
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf",
			version: 1,
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "ada@example.com",
			uploadedAt: new Date("2026-05-21T09:10:00.000Z"),
		});

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				headers: {
					"x-sender-session-token": "verified-sender-token",
					"x-now": "2026-05-21T09:10:00.000Z",
				},
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				id: "10000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf",
				version: 1,
				sha256: "a".repeat(64),
				byteSize: 10,
				contentType: "application/pdf",
				originalFilename: "document.pdf",
				uploadedBy: "ada@example.com",
				uploadedAt: "2026-05-21T09:10:00.000Z",
			},
		});
	});

	it("streams the persisted source PDF content for browser previews", async () => {
		const pdfBytes = pdfFixtureBytes("preview");
		state.sourceDocuments.push({
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf",
			version: 1,
			sha256: "a".repeat(64),
			byteSize: pdfBytes.byteLength,
			contentType: "application/pdf",
			uploadedBy: "ada@example.com",
			uploadedAt: new Date("2026-05-21T09:10:00.000Z"),
		});

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf/content?senderSessionToken=verified-sender-token",
			{},
			{
				DOCUMENTS_BUCKET: {
					get: async (key: string) => ({
						arrayBuffer: async () => {
							expect(key).toBe("envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf");
							return pdfBytes.buffer;
						},
					}),
				},
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(response.headers.get("content-disposition")).toBe("inline");
		expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(pdfFixtureText("preview"));
	});

	it("returns an actionable source PDF missing response for a verified sender session", async () => {
		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				headers: {
					"x-sender-session-token": "verified-sender-token",
					"x-now": "2026-05-21T09:10:00.000Z",
				},
			},
		);

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "SOURCE_PDF_NOT_FOUND",
				message: "Upload a source PDF before preparing or sending this envelope",
				allowedActions: ["upload_source_pdf"],
			},
		});
	});

	it("rejects empty, duplicate, and over-limit uploads with stable errors and audit evidence", async () => {
		const bucket = {
			put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
				storeR2Object(key, value);
				return null;
			},
		};

		const empty = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				method: "POST",
				headers: {
					"x-sender-session-token": "verified-sender-token",
					"x-now": "2026-05-21T09:10:00.000Z",
					"content-type": "application/pdf",
				},
				body: new Uint8Array(),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);

		expect(empty.status).toBe(400);
		await expect(empty.json()).resolves.toEqual({
			error: {
				code: "INVALID_SOURCE_PDF",
				message: "Source document must be a PDF",
				validValues: ["application/pdf"],
			},
		});

		const tooLargeBytes = new Uint8Array(MAX_SOURCE_PDF_BYTES + 1);
		tooLargeBytes.set(new TextEncoder().encode("%PDF-"), 0);
		const tooLarge = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				method: "POST",
				headers: {
					"x-sender-session-token": "verified-sender-token",
					"x-now": "2026-05-21T09:10:00.000Z",
					"content-type": "application/pdf",
				},
				body: tooLargeBytes,
			},
			{ DOCUMENTS_BUCKET: bucket },
		);

		expect(tooLarge.status).toBe(413);
		await expect(tooLarge.json()).resolves.toEqual({
			error: {
				code: "SOURCE_PDF_TOO_LARGE",
				message: "Source PDF must be at most 2 MiB",
				limitBytes: MAX_SOURCE_PDF_BYTES,
			},
		});

		state.sourceDocuments.push({
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf",
			version: 1,
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "ada@example.com",
			uploadedAt: new Date("2026-05-21T09:10:00.000Z"),
		});
		const duplicate = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				method: "POST",
				headers: {
					"x-sender-session-token": "verified-sender-token",
					"x-now": "2026-05-21T09:10:00.000Z",
					"content-type": "application/pdf",
				},
				body: pdfFixtureBytes(),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);

		expect(duplicate.status).toBe(409);
		await expect(duplicate.json()).resolves.toEqual({
			error: {
				code: "DUPLICATE_SOURCE_PDF",
				message: "Envelope already has a source PDF",
			},
		});
		expect(state.r2Objects.size).toBe(0);
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "source_pdf.upload_rejected" }),
				expect.objectContaining({ eventType: "source_pdf.upload_too_large" }),
				expect.objectContaining({ eventType: "source_pdf.upload_duplicate" }),
			]),
		);
	});

	it("reuses idempotent upload results without duplicating document rows or R2 objects", async () => {
		const bucket = {
			put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
				storeR2Object(key, value);
				return null;
			},
		};
		const request = {
			method: "POST",
			headers: {
				"x-sender-session-token": "verified-sender-token",
				"x-now": "2026-05-21T09:10:00.000Z",
				"idempotency-key": "source-upload-1",
				"content-type": "application/pdf",
			},
			body: pdfFixtureBytes(),
		};

		const first = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			request,
			{ DOCUMENTS_BUCKET: bucket },
		);
		const second = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			request,
			{ DOCUMENTS_BUCKET: bucket },
		);

		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual(await first.json());
		expect(state.sourceDocuments).toHaveLength(1);
		expect(state.r2Objects.size).toBe(1);
	});

	it("stores a revised source version and clears dependent fields from changes requested state", async () => {
		state.envelopes[0] = { ...state.envelopes[0], status: "changes_requested" };
		state.sourceDocuments.push({
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf",
			version: 1,
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "ada@example.com",
			uploadedAt: new Date("2026-05-21T09:10:00.000Z"),
		});
		state.fields.push({
			id: "50000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			type: "signature",
			page: 1,
			x: 72,
			y: 144,
			width: 180,
			height: 48,
			createdAt: new Date("2026-05-21T09:15:00.000Z"),
		});

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				method: "POST",
				headers: {
					"x-sender-session-token": "verified-sender-token",
					"x-now": "2026-05-21T09:10:00.000Z",
					"content-type": "application/pdf",
					"x-source-filename": "revised-contract.pdf",
				},
				body: pdfFixtureBytes("revised"),
			},
			{
				DOCUMENTS_BUCKET: {
					put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
						storeR2Object(key, value);
						return null;
					},
				},
			},
		);

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({
			data: expect.objectContaining({
				r2Key: expect.stringContaining("source-v2.pdf"),
				version: 2,
				originalFilename: "revised-contract.pdf",
			}),
		});
		expect(state.fields).toHaveLength(0);
		expect(state.envelopes[0]?.status).toBe("draft");
		expect(state.auditEvents).toEqual([
			expect.objectContaining({ eventType: "source_pdf.revised" }),
		]);
	});
});
