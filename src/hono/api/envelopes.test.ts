import {
	auditEvents as auditEventsTable,
	envelopes as envelopesTable,
	idempotencyRecords as idempotencyRecordsTable,
	sourceDocuments as sourceDocumentsTable,
} from "@/db/envelope";
import { MAX_SOURCE_PDF_BYTES } from "@/db/envelope/pdf-policy";
import { apiHono } from "@/hono/api";
import { pdfFixtureBytes } from "@/test/pdf-fixtures";

const dbState = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	auditEventsTable: null as unknown,
	idempotencyRecordsTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	insertedEnvelopes: [] as Array<{
		id: string;
		status: "draft";
		createdBy: string;
		createdAt: Date;
	}>,
	idempotencyRecords: [] as Array<{
		key: string;
		operation: string;
		createdBy: string;
		envelopeId: string;
	}>,
	sourceDocuments: [] as Array<{
		id: string;
		envelopeId: string;
		version: number;
		r2Key: string;
		sha256: string;
		byteSize: number;
		contentType: string;
		uploadedBy: string;
		uploadedAt: Date;
	}>,
	auditEvents: [] as Array<Record<string, unknown>>,
	r2Objects: new Map<string, Uint8Array>(),
}));

const insertedEnvelopes = dbState.insertedEnvelopes;

type InsertedEnvelope = {
	id: string;
	status: "draft";
	createdBy: string;
	createdAt: Date;
};

type SourceDocument = (typeof dbState.sourceDocuments)[number];

function selectRows(table: unknown): unknown[] {
	if (table === dbState.idempotencyRecordsTable) return dbState.idempotencyRecords;
	if (table === dbState.envelopesTable) return selectEnvelopeRows();
	if (table === dbState.sourceDocumentsTable) return dbState.sourceDocuments;
	if (table === dbState.auditEventsTable) return dbState.auditEvents;
	return [];
}

function selectEnvelopeRows(): InsertedEnvelope[] {
	const record = dbState.idempotencyRecords[0];
	if (!record) return dbState.insertedEnvelopes;
	return dbState.insertedEnvelopes.filter((envelope) => envelope.id === record.envelopeId);
}

function insertRow(
	table: unknown,
	value: Partial<InsertedEnvelope> &
		Partial<SourceDocument> & { envelopeId?: string; key?: string; operation?: string },
): unknown[] {
	if (table === dbState.idempotencyRecordsTable) return insertIdempotencyRecord(value);
	if (table === dbState.sourceDocumentsTable) return insertSourceDocument(value);
	if (table === dbState.auditEventsTable) return insertAuditEvent(value);
	return insertEnvelope(value);
}

function insertIdempotencyRecord(
	value: Partial<InsertedEnvelope> &
		Partial<SourceDocument> & { envelopeId?: string; key?: string; operation?: string },
): [] {
	dbState.idempotencyRecords.push({
		key: value.key ?? "",
		operation: value.operation ?? "envelope.create",
		createdBy: value.createdBy ?? "",
		envelopeId: value.envelopeId ?? "",
	});
	return [];
}

function insertAuditEvent(value: Record<string, unknown>): [] {
	dbState.auditEvents.push(value);
	return [];
}

function insertSourceDocument(value: Partial<SourceDocument>): SourceDocument[] {
	const row = {
		id: `10000000-0000-4000-8000-${String(dbState.sourceDocuments.length + 1).padStart(12, "0")}`,
		envelopeId: value.envelopeId ?? "",
		r2Key: value.r2Key ?? "",
		version: value.version ?? 1,
		sha256: value.sha256 ?? "",
		byteSize: value.byteSize ?? 0,
		contentType: value.contentType ?? "",
		uploadedBy: value.uploadedBy ?? "",
		uploadedAt: new Date("2026-05-20T07:01:00.000Z"),
	};
	dbState.sourceDocuments.push(row);
	return [row];
}

function insertEnvelope(value: Partial<InsertedEnvelope>): InsertedEnvelope[] {
	const row = {
		id: `00000000-0000-4000-8000-${String(dbState.insertedEnvelopes.length + 1).padStart(12, "0")}`,
		status: "draft" as const,
		createdBy: value.createdBy ?? "",
		createdAt: new Date("2026-05-20T07:00:00.000Z"),
	};
	dbState.insertedEnvelopes.push(row);
	return [row];
}

function storeR2Object(key: string, value: ArrayBuffer | ArrayBufferView) {
	const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
	dbState.r2Objects.set(key, bytes);
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
			values: (
				value: Partial<InsertedEnvelope> &
					Partial<SourceDocument> & { envelopeId?: string; key?: string; operation?: string },
			) => ({
				returning: async () => insertRow(table, value),
			}),
		}),
	}),
}));

describe("envelopes API", () => {
	beforeEach(() => {
		dbState.envelopesTable = envelopesTable;
		dbState.auditEventsTable = auditEventsTable;
		dbState.idempotencyRecordsTable = idempotencyRecordsTable;
		dbState.sourceDocumentsTable = sourceDocumentsTable;
		dbState.insertedEnvelopes.length = 0;
		dbState.idempotencyRecords.length = 0;
		dbState.sourceDocuments.length = 0;
		dbState.auditEvents.length = 0;
		dbState.r2Objects.clear();
	});

	it("creates an authenticated draft envelope with stable JSON", async () => {
		// Assumptions for issue #6 RED:
		// - Minimal internal auth is carried by x-internal-user-id until a fuller auth layer exists.
		// - Draft creation returns { data } with id, status, createdBy, and createdAt.
		// - PDF upload, recipients, fields, signing, emails, and final PDFs are intentionally out of scope.
		const response = await apiHono.request("/api/envelopes", {
			method: "POST",
			headers: {
				"x-internal-user-id": "user_123",
				"idempotency-key": "create-envelope-1",
			},
		});

		expect(response.status).toBe(201);
		const body = await response.json();
		expect(body).toEqual({
			data: {
				id: expect.any(String),
				status: "draft",
				createdBy: "user_123",
				createdAt: expect.any(String),
			},
		});
		expect(insertedEnvelopes).toHaveLength(1);
		expect(insertedEnvelopes[0]?.createdBy).toBe("user_123");
		expect(insertedEnvelopes[0]?.createdAt).toBeInstanceOf(Date);
	});

	it("returns the original draft envelope for a repeated idempotency key", async () => {
		const request = {
			method: "POST",
			headers: {
				"x-internal-user-id": "user_123",
				"idempotency-key": "create-envelope-1",
			},
		};

		const first = await apiHono.request("/api/envelopes", request);
		const second = await apiHono.request("/api/envelopes", request);

		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual(await first.json());
		expect(insertedEnvelopes).toHaveLength(1);
	});

	it("returns machine-readable valid values for invalid lifecycle actions", async () => {
		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/actions",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "user_123",
					"content-type": "application/json",
				},
				body: JSON.stringify({ action: "archive" }),
			},
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "INVALID_ACTION",
				message: "Invalid envelope lifecycle action",
				validValues: ["send", "cancel", "expire", "delete"],
			},
		});
	});

	it("uploads a valid source PDF at most 2 MiB to R2 and persists document metadata", async () => {
		// Assumptions for issue #7 RED:
		// - Source PDF upload uses POST /api/envelopes/:id/source-pdf with application/pdf bytes.
		// - R2 storage is accessed through the DOCUMENTS_BUCKET binding.
		// - One source PDF is attached to a draft envelope in this slice; preview/finalization stay out of scope.
		dbState.insertedEnvelopes.push({
			id: "00000000-0000-4000-8000-000000000001",
			status: "draft",
			createdBy: "user_123",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
		});

		const pdfBytes = pdfFixtureBytes();
		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "user_123",
					"idempotency-key": "upload-pdf-1",
					"content-type": "application/pdf",
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
				originalFilename: "document.pdf",
				uploadedBy: "user_123",
				uploadedAt: expect.any(String),
			},
		});
		expect(dbState.sourceDocuments).toHaveLength(1);
		expect(dbState.r2Objects.has(body.data.r2Key)).toBe(true);
	});

	it("rejects non-PDF and over-limit source uploads with stable errors", async () => {
		dbState.insertedEnvelopes.push({
			id: "00000000-0000-4000-8000-000000000001",
			status: "draft",
			createdBy: "user_123",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
		});

		const nonPdf = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "user_123",
					"content-type": "text/plain",
				},
				body: "not a pdf",
			},
			{ DOCUMENTS_BUCKET: { put: async () => null } },
		);

		expect(nonPdf.status).toBe(400);
		await expect(nonPdf.json()).resolves.toEqual({
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
					"x-internal-user-id": "user_123",
					"content-type": "application/pdf",
				},
				body: tooLargeBytes,
			},
			{ DOCUMENTS_BUCKET: { put: async () => null } },
		);

		expect(tooLarge.status).toBe(413);
		await expect(tooLarge.json()).resolves.toEqual({
			error: {
				code: "SOURCE_PDF_TOO_LARGE",
				message: "Source PDF must be at most 2 MiB",
				limitBytes: MAX_SOURCE_PDF_BYTES,
			},
		});
		expect(dbState.sourceDocuments).toHaveLength(0);
		expect(dbState.r2Objects.size).toBe(0);
	});

	it("returns the original source document for a repeated upload idempotency key", async () => {
		dbState.insertedEnvelopes.push({
			id: "00000000-0000-4000-8000-000000000001",
			status: "draft",
			createdBy: "user_123",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
		});
		const bucket = {
			put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
				storeR2Object(key, value);
				return null;
			},
		};
		const request = {
			method: "POST",
			headers: {
				"x-internal-user-id": "user_123",
				"idempotency-key": "upload-pdf-1",
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
		expect(dbState.sourceDocuments).toHaveLength(1);
	});
});
