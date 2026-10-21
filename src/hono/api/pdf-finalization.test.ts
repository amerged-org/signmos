import { PDFDocument } from "pdf-lib";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	senderVerificationEmailRecords,
	senderVerificationTokens,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { FINAL_PDF_RENDERER_PRODUCER } from "@/db/envelope/final-pdf-renderer";
import { apiHono } from "@/hono/api";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	recipientsTable: null as unknown,
	fieldsTable: null as unknown,
	tokensTable: null as unknown,
	fieldValuesTable: null as unknown,
	auditEventsTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	finalDocumentsTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	senderVerificationTokensTable: null as unknown,
	senderVerificationEmailRecordsTable: null as unknown,
	envelopes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			status: "sent",
			createdBy: "sender@example.com",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
			sentBy: "sender@example.com",
			sentAt: new Date("2026-05-20T07:04:00.000Z"),
		},
	],
	recipients: [
		{
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "sent",
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
		},
	],
	fields: [
		{
			id: "50000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			type: "signature",
			page: 1,
			x: 72,
			y: 144,
			width: 180,
			height: 48,
			createdAt: new Date("2026-05-20T07:05:00.000Z"),
		},
		{
			id: "50000000-0000-4000-8000-000000000002",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			type: "date",
			page: 1,
			x: 300,
			y: 144,
			width: 120,
			height: 32,
			createdAt: new Date("2026-05-20T07:05:00.000Z"),
		},
	],
	tokens: [
		{
			id: "30000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			token: "valid-token",
			status: "active",
			expiresAt: new Date("2026-05-27T07:03:00.000Z"),
			verifiedAt: new Date("2026-05-20T07:04:00.000Z"),
			createdAt: new Date("2026-05-20T07:03:00.000Z"),
		},
	] as Array<Record<string, unknown>>,
	sourceDocuments: [
		{
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source.pdf",
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "user_123",
			uploadedAt: new Date("2026-05-20T07:01:00.000Z"),
		},
	],
	senderVerificationTokens: [
		{
			id: "70000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Sender Example",
			email: "sender@example.com",
			token: "sender-token",
			status: "verified",
			expiresAt: new Date("2026-05-20T08:30:00.000Z"),
			verifiedAt: new Date("2026-05-20T07:00:00.000Z"),
			createdAt: new Date("2026-05-20T06:59:00.000Z"),
		},
	],
	fieldValues: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	finalDocuments: [] as Array<Record<string, unknown>>,
	emailSendRecords: [] as Array<Record<string, unknown>>,
	senderVerificationEmailRecords: [] as Array<Record<string, unknown>>,
	r2Objects: new Map<string, Uint8Array>(),
}));

function selectRows(table: unknown) {
	if (table === state.tokensTable) return state.tokens;
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.fieldValuesTable) return state.fieldValues;
	if (table === state.auditEventsTable) return state.auditEvents;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.finalDocumentsTable) return state.finalDocuments;
	if (table === state.emailSendRecordsTable) return state.emailSendRecords;
	if (table === state.senderVerificationTokensTable) return state.senderVerificationTokens;
	if (table === state.senderVerificationEmailRecordsTable) {
		return state.senderVerificationEmailRecords;
	}
	return [];
}

function insertRows(table: unknown, rows: Array<Record<string, unknown>>) {
	if (table === state.fieldValuesTable) state.fieldValues.push(...rows);
	if (table === state.auditEventsTable) state.auditEvents.push(...rows);
	if (table === state.finalDocumentsTable) return insertFinalDocuments(rows);
	if (table === state.emailSendRecordsTable) state.emailSendRecords.push(...rows);
	if (table === state.senderVerificationEmailRecordsTable) {
		state.senderVerificationEmailRecords.push(...rows);
	}
	return rows;
}

function insertFinalDocuments(rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row, index) => ({
		id: `90000000-0000-4000-8000-${String(state.finalDocuments.length + index + 1).padStart(12, "0")}`,
		...row,
		createdAt: new Date("2026-05-20T08:01:00.000Z"),
	}));
	state.finalDocuments.push(...inserted);
	return inserted;
}

vi.mock("@/db/setup", async () => {
	const { wrapSigningTestDb } = await import("@/db/envelope/signing-test-db");
	return {
		getDb: () =>
			wrapSigningTestDb(
				{
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
						set: (value: { status?: string }) => ({
							where: async () => {
								if (table === state.recipientsTable) {
									state.recipients[0] = { ...state.recipients[0], status: value.status ?? "sent" };
								}
								if (table === state.envelopesTable) {
									state.envelopes[0] = { ...state.envelopes[0], status: value.status ?? "sent" };
								}
								if (table === state.finalDocumentsTable) {
									state.finalDocuments[0] = { ...state.finalDocuments[0], ...value };
								}
								return [];
							},
						}),
					}),
				},
				selectRows,
			),
	};
});

describe("PDF finalization", () => {
	beforeEach(async () => {
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.fieldsTable = envelopeFields;
		state.tokensTable = signerTokens;
		state.fieldValuesTable = fieldValues;
		state.auditEventsTable = auditEvents;
		state.sourceDocumentsTable = sourceDocuments;
		state.finalDocumentsTable = finalDocuments;
		state.emailSendRecordsTable = emailSendRecords;
		state.senderVerificationTokensTable = senderVerificationTokens;
		state.senderVerificationEmailRecordsTable = senderVerificationEmailRecords;
		state.fieldValues.length = 0;
		state.auditEvents.length = 0;
		state.finalDocuments.length = 0;
		state.emailSendRecords.length = 0;
		state.senderVerificationEmailRecords.length = 0;
		state.r2Objects.clear();
		state.recipients.length = 1;
		state.tokens.length = 1;
		state.envelopes[0] = { ...state.envelopes[0], status: "sent" };
		state.recipients[0] = { ...state.recipients[0], status: "sent" };
		state.tokens[0] = {
			...state.tokens[0],
			expiresAt: new Date("2026-05-27T07:03:00.000Z"),
			verifiedAt: new Date("2026-05-20T07:04:00.000Z"),
		};
		state.r2Objects.set(String(state.sourceDocuments[0]?.r2Key), await createSourcePdfBytes());
	});

	it("keeps the envelope sent until every required recipient completes", async () => {
		state.recipients.push({
			id: "20000000-0000-4000-8000-000000000002",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Grace Hopper",
			email: "grace@example.com",
			status: "sent",
			createdAt: new Date("2026-05-20T07:02:30.000Z"),
		});
		const bucket = {
			get: async (key: string) => {
				const bytes = state.r2Objects.get(key);
				return bytes ? { arrayBuffer: async () => toArrayBuffer(bytes) } : null;
			},
			put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
				const bytes =
					value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
				state.r2Objects.set(key, bytes);
				return null;
			},
		};

		const response = await apiHono.request(
			"/api/signing/valid-token/complete",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-now": "2026-05-20T08:00:00.000Z",
				},
				body: JSON.stringify({ signatureName: "Ada Lovelace", date: "2026-05-20" }),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: expect.objectContaining({
				envelopeStatus: "sent",
				recipientStatus: "completed",
			}),
		});
		expect(state.envelopes[0]?.status).toBe("sent");
		expect(state.finalDocuments).toHaveLength(0);
		expect(state.emailSendRecords).toEqual([
			expect.objectContaining({
				email: "sender@example.com",
				kind: "partner_signed",
				fallbackUrl: "/envelope-fields?envelopeId=00000000-0000-4000-8000-000000000001",
			}),
		]);
		expect(state.senderVerificationEmailRecords).toHaveLength(0);
		expect(state.r2Objects.size).toBe(1);
	});

	it("generates a final PDF with flattened values and audit summary when all recipients complete", async () => {
		// #19 assumptions before RED:
		// - Completion notifications are persisted as send records, not real Resend calls.
		// - Sender completion fallback uses the verified sender process token.
		// - Partner completion fallback uses the verified signing process token.
		// - The certificate checksum is a deterministic hash over signing inputs, not a self-hash.
		const bucket = {
			get: async (key: string) => {
				const bytes = state.r2Objects.get(key);
				return bytes ? { arrayBuffer: async () => toArrayBuffer(bytes) } : null;
			},
			put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
				const bytes =
					value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
				state.r2Objects.set(key, bytes);
				return null;
			},
		};

		const response = await apiHono.request(
			"/api/signing/valid-token/complete",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-now": "2026-05-20T08:00:00.000Z",
				},
				body: JSON.stringify({ signatureName: "Ada Lovelace", date: "2026-05-20" }),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: expect.objectContaining({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				envelopeStatus: "completed",
			}),
		});
		expect(state.finalDocuments).toHaveLength(1);
		const finalKey = state.finalDocuments[0]?.r2Key as string;
		const finalPdfBytes = state.r2Objects.get(finalKey);
		if (!finalPdfBytes) throw new Error("Final PDF was not written");
		const finalPdf = new TextDecoder().decode(finalPdfBytes);
		const parsedFinalPdf = await PDFDocument.load(finalPdfBytes);
		expect(parsedFinalPdf.getPageCount()).toBe(2);
		expect(finalPdf.slice(0, 5)).toBe("%PDF-");
		expect(state.fieldValues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ value: "Ada Lovelace" }),
				expect.objectContaining({ value: "2026-05-20" }),
			]),
		);
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([expect.objectContaining({ eventType: "recipient.completed" })]),
		);
		expect(state.emailSendRecords).toEqual([
			expect.objectContaining({
				email: "sender@example.com",
				kind: "partner_signed",
				fallbackUrl: "/envelope-fields?envelopeId=00000000-0000-4000-8000-000000000001",
			}),
			expect.objectContaining({
				email: "ada@example.com",
				kind: "completion",
				fallbackUrl: "/completed-documents/valid-token",
			}),
		]);
		expect(state.senderVerificationEmailRecords).toEqual([
			expect.objectContaining({
				email: "sender@example.com",
				kind: "completion",
				fallbackUrl: `/completed-documents/${state.finalDocuments[0]?.id}`,
			}),
		]);
		for (const record of [...state.emailSendRecords, ...state.senderVerificationEmailRecords]) {
			expect(record).not.toHaveProperty("attachment");
			expect(record).not.toHaveProperty("pdfAttachment");
		}
	});

	it("reports final PDF availability and repairs stale downloads through process links", async () => {
		const finalPdf = await createSourcePdfBytes();
		const r2Key = "envelopes/00000000-0000-4000-8000-000000000001/final.pdf";
		state.finalDocuments.push({
			id: "90000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key,
			sha256: "b".repeat(64),
			byteSize: finalPdf.byteLength,
			contentType: "application/pdf",
			createdAt: new Date("2026-05-20T08:01:00.000Z"),
		});
		state.envelopes[0] = { ...state.envelopes[0], status: "completed" };
		state.r2Objects.set(r2Key, finalPdf);
		const bucket = {
			get: async (key: string) => {
				const bytes = state.r2Objects.get(key);
				return bytes ? { arrayBuffer: async () => toArrayBuffer(bytes) } : null;
			},
			put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
				const bytes =
					value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
				state.r2Objects.set(key, bytes);
				return null;
			},
		};

		const statusResponse = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/status",
		);

		expect(statusResponse.status).toBe(200);
		await expect(statusResponse.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				status: "completed",
				finalPdfAvailable: true,
				allowedActions: ["download_final_pdf", "delete"],
				pendingRecipients: [],
			},
		});

		const finalTokenDownload = await apiHono.request(
			"/api/final-documents/90000000-0000-4000-8000-000000000001/pdf",
			undefined,
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(finalTokenDownload.status).toBe(200);
		expect(finalTokenDownload.headers.get("content-type")).toBe("application/pdf");
		const tokenPdf = await PDFDocument.load(await finalTokenDownload.arrayBuffer(), {
			updateMetadata: false,
		});
		expect(tokenPdf.getProducer()).toBe(FINAL_PDF_RENDERER_PRODUCER);
		const regeneratedKey = String(state.finalDocuments[0]?.r2Key);
		expect(regeneratedKey).not.toBe(r2Key);
		expect(state.r2Objects.get(r2Key)).toEqual(finalPdf);
		const storedPdf = await PDFDocument.load(
			state.r2Objects.get(regeneratedKey) ?? new Uint8Array(),
			{
				updateMetadata: false,
			},
		);
		expect(storedPdf.getProducer()).toBe(FINAL_PDF_RENDERER_PRODUCER);

		const senderDownload = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/final-pdf?senderSessionToken=sender-token",
			{ headers: { "x-now": "2026-05-20T08:00:00.000Z" } },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(senderDownload.status).toBe(200);
		expect(senderDownload.headers.get("content-type")).toBe("application/pdf");
		expect(PDFDocument.load(await senderDownload.arrayBuffer())).resolves.toBeTruthy();

		const signerDownload = await apiHono.request(
			"/api/signing/valid-token/final-pdf",
			{ headers: { "x-now": "2026-05-20T08:00:00.000Z" } },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(signerDownload.status).toBe(200);
		expect(signerDownload.headers.get("content-type")).toBe("application/pdf");
		expect(PDFDocument.load(await signerDownload.arrayBuffer())).resolves.toBeTruthy();
	});

	it("blocks unverified, expired, and deleted final PDF access", async () => {
		const finalPdf = new TextEncoder().encode("%PDF-1.4\ncompleted artifact\n%%EOF");
		const r2Key = "envelopes/00000000-0000-4000-8000-000000000001/final.pdf";
		state.finalDocuments.push({
			id: "90000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key,
			sha256: "b".repeat(64),
			byteSize: finalPdf.byteLength,
			contentType: "application/pdf",
			createdAt: new Date("2026-05-20T08:01:00.000Z"),
		});
		state.envelopes[0] = { ...state.envelopes[0], status: "completed" };
		state.r2Objects.set(r2Key, finalPdf);
		const bucket = {
			get: async (key: string) => ({
				arrayBuffer: async () => state.r2Objects.get(key)?.buffer,
			}),
		};

		state.tokens[0] = { ...state.tokens[0], verifiedAt: null };
		const unverified = await apiHono.request(
			"/api/signing/valid-token/final-pdf",
			{ headers: { "x-now": "2026-05-20T08:00:00.000Z" } },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(unverified.status).toBe(403);

		state.tokens[0] = {
			...state.tokens[0],
			verifiedAt: new Date("2026-05-20T07:04:00.000Z"),
			expiresAt: new Date("2026-05-20T07:30:00.000Z"),
		};
		const expired = await apiHono.request(
			"/api/signing/valid-token/final-pdf",
			{ headers: { "x-now": "2026-05-20T08:00:00.000Z" } },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(expired.status).toBe(410);

		state.tokens[0] = {
			...state.tokens[0],
			expiresAt: new Date("2026-05-27T07:03:00.000Z"),
		};
		state.envelopes[0] = { ...state.envelopes[0], status: "deleted" };
		const deleted = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/final-pdf?senderSessionToken=sender-token",
			{ headers: { "x-now": "2026-05-20T08:00:00.000Z" } },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(deleted.status).toBe(404);
	});
});

async function createSourcePdfBytes(): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	pdf.addPage([612, 792]);
	return pdf.save({ useObjectStreams: false });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
