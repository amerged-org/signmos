import { PDFDocument } from "pdf-lib";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureBytes } from "@/test/pdf-fixtures";

const envelopeId = "00000000-0000-4000-8000-000000000001";
const recipientId = "20000000-0000-4000-8000-000000000001";
const signerTokenValue = "self-sign-token";

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
	envelopes: [] as Array<Record<string, unknown>>,
	recipients: [] as Array<Record<string, unknown>>,
	fields: [] as Array<Record<string, unknown>>,
	tokens: [] as Array<Record<string, unknown>>,
	fieldValues: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	sourceDocuments: [] as Array<Record<string, unknown>>,
	finalDocuments: [] as Array<Record<string, unknown>>,
	emailSendRecords: [] as Array<Record<string, unknown>>,
	r2Objects: new Map<string, Uint8Array>(),
}));

function selectRows(table: unknown): Array<Record<string, unknown>> {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.tokensTable) return state.tokens;
	if (table === state.fieldValuesTable) return state.fieldValues;
	if (table === state.auditEventsTable) return state.auditEvents;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.finalDocumentsTable) return state.finalDocuments;
	if (table === state.emailSendRecordsTable) return state.emailSendRecords;
	return [];
}

function insertRows(
	table: unknown,
	rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	if (table === state.fieldValuesTable) state.fieldValues.push(...rows);
	if (table === state.auditEventsTable) state.auditEvents.push(...rows);
	if (table === state.emailSendRecordsTable) state.emailSendRecords.push(...rows);
	if (table === state.finalDocumentsTable) return insertFinalDocuments(rows);
	return rows;
}

function insertFinalDocuments(rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row, index) => ({
		id: `90000000-0000-4000-8000-${String(state.finalDocuments.length + index + 1).padStart(12, "0")}`,
		createdAt: new Date("2026-05-23T08:01:00.000Z"),
		...row,
	}));
	state.finalDocuments.push(...inserted);
	return inserted;
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
			set: (value: { status?: string }) => ({
				where: async () => {
					if (table === state.recipientsTable) {
						state.recipients[0] = { ...state.recipients[0], status: value.status ?? "sent" };
					}
					if (table === state.envelopesTable) {
						state.envelopes[0] = { ...state.envelopes[0], status: value.status ?? "sent" };
					}
					return [];
				},
			}),
		}),
	}),
}));

describe("self-sign completion detail links", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.fieldsTable = envelopeFields;
		state.tokensTable = signerTokens;
		state.fieldValuesTable = fieldValues;
		state.auditEventsTable = auditEvents;
		state.sourceDocumentsTable = sourceDocuments;
		state.finalDocumentsTable = finalDocuments;
		state.emailSendRecordsTable = emailSendRecords;
		resetState();
	});

	it("completes a one-recipient envelope and exposes signer-specific detail/download links", async () => {
		// Assumptions for issue #32 RED:
		// - Self-sign completion reuses the normal complete-signing and finalization path.
		// - The signer token is the secure involved-signer detail token after completion.
		// - Possessing that signer token is enough to view/download the completed document after completion.
		// - History table, cancel/delete controls, and new email providers are out of scope.
		const bucket = bucketStub();

		const complete = await apiHono.request(
			`/api/signing/${signerTokenValue}/complete`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-now": "2026-05-23T08:00:00.000Z",
				},
				body: JSON.stringify({
					signature: {
						kind: "typed",
						typedText: "Ada Self Sign",
						typedFont: "serif",
					},
					rememberSignature: false,
				}),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);

		expect(complete.status).toBe(200);
		await expect(complete.json()).resolves.toEqual({
			data: expect.objectContaining({
				envelopeId,
				recipientId,
				recipientStatus: "completed",
				envelopeStatus: "completed",
			}),
		});
		expect(state.envelopes[0]?.status).toBe("completed");
		expect(state.finalDocuments).toHaveLength(1);
		expect(state.emailSendRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					recipientId,
					kind: "completion",
					fallbackUrl: `/completed-documents/${signerTokenValue}`,
				}),
			]),
		);
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "field.value.completed" }),
				expect.objectContaining({ eventType: "recipient.completed" }),
			]),
		);

		state.tokens[0] = { ...state.tokens[0], verifiedAt: null };
		const signingLink = await apiHono.request(`/api/signing/${signerTokenValue}`, {
			headers: { "x-now": "2026-05-23T08:05:00.000Z" },
		});
		expect(signingLink.status).toBe(200);
		await expect(signingLink.json()).resolves.toEqual({
			data: {
				completedDocument: {
					url: `/completed-documents/${signerTokenValue}`,
					downloadUrl: `/api/final-documents/${signerTokenValue}/pdf`,
				},
			},
		});

		const detail = await apiHono.request(`/api/final-documents/${signerTokenValue}`, {
			headers: { "x-now": "2026-05-23T08:05:00.000Z" },
		});
		expect(detail.status).toBe(200);
		await expect(detail.json()).resolves.toEqual({
			data: expect.objectContaining({
				status: "completed",
				finalPdf: expect.objectContaining({
					downloadUrl: `/api/final-documents/${signerTokenValue}/pdf`,
				}),
				parties: [
					expect.objectContaining({
						id: recipientId,
						email: "ada@example.com",
						status: "completed",
					}),
				],
			}),
		});

		const download = await apiHono.request(
			`/api/final-documents/${signerTokenValue}/pdf`,
			{ headers: { "x-now": "2026-05-23T08:05:00.000Z" } },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(download.status).toBe(200);
		expect(download.headers.get("content-type")).toBe("application/pdf");
		const finalPdf = await PDFDocument.load(await download.arrayBuffer());
		expect(finalPdf.getPageCount()).toBe(2);
	});

	it("rejects expired signer detail links before exposing completed document access", async () => {
		seedCompletedFinalDocument();
		state.tokens[0] = {
			...state.tokens[0],
			verifiedAt: null,
			expiresAt: new Date("2026-05-23T08:00:00.000Z"),
		};

		const response = await apiHono.request(`/api/signing/${signerTokenValue}`, {
			headers: { "x-now": "2026-05-23T08:05:00.000Z" },
		});

		expect(response.status).toBe(410);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "EXPIRED_TOKEN",
				message: "Signing token has expired",
			},
		});
	});
});

function resetState() {
	state.envelopes = [
		{
			id: envelopeId,
			status: "sent",
			signingMode: "only_me",
			createdBy: "ada@example.com",
			createdAt: new Date("2026-05-23T07:00:00.000Z"),
			sentBy: "ada@example.com",
			sentAt: new Date("2026-05-23T07:04:00.000Z"),
		},
	];
	state.recipients = [
		{
			id: recipientId,
			envelopeId,
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "sent",
			createdAt: new Date("2026-05-23T07:02:00.000Z"),
		},
	];
	state.fields = [
		{
			id: "50000000-0000-4000-8000-000000000001",
			envelopeId,
			recipientId,
			type: "signature",
			page: 1,
			x: 360,
			y: 628,
			width: 180,
			height: 48,
			createdAt: new Date("2026-05-23T07:05:00.000Z"),
		},
		{
			id: "50000000-0000-4000-8000-000000000002",
			envelopeId,
			recipientId,
			type: "date",
			page: 1,
			x: 420,
			y: 688,
			width: 120,
			height: 32,
			createdAt: new Date("2026-05-23T07:05:00.000Z"),
		},
	];
	state.tokens = [
		{
			id: "30000000-0000-4000-8000-000000000001",
			envelopeId,
			recipientId,
			token: signerTokenValue,
			status: "active",
			expiresAt: new Date("2026-05-30T07:03:00.000Z"),
			verifiedAt: new Date("2026-05-23T07:04:00.000Z"),
			createdAt: new Date("2026-05-23T07:03:00.000Z"),
		},
	];
	state.sourceDocuments = [
		{
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId,
			r2Key: `envelopes/${envelopeId}/source.pdf`,
			version: 1,
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "ada@example.com",
			uploadedAt: new Date("2026-05-23T07:01:00.000Z"),
		},
	];
	state.fieldValues = [];
	state.auditEvents = [];
	state.finalDocuments = [];
	state.emailSendRecords = [];
	state.r2Objects.clear();
	const sourcePdf = pdfFixtureBytes("Self-sign agreement");
	state.sourceDocuments[0] = { ...state.sourceDocuments[0], byteSize: sourcePdf.byteLength };
	state.r2Objects.set(`envelopes/${envelopeId}/source.pdf`, sourcePdf);
}

function seedCompletedFinalDocument() {
	const finalPdf = new TextEncoder().encode("%PDF-1.4\ncompleted artifact\n%%EOF");
	state.envelopes[0] = { ...state.envelopes[0], status: "completed" };
	state.finalDocuments = [
		{
			id: "90000000-0000-4000-8000-000000000001",
			envelopeId,
			r2Key: `envelopes/${envelopeId}/final.pdf`,
			sha256: "b".repeat(64),
			byteSize: finalPdf.byteLength,
			contentType: "application/pdf",
			createdAt: new Date("2026-05-23T08:01:00.000Z"),
		},
	];
	state.r2Objects.set(`envelopes/${envelopeId}/final.pdf`, finalPdf);
}

function bucketStub() {
	return {
		put: async (key: string, value: ArrayBuffer | ArrayBufferView) => {
			const bytes =
				value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
			state.r2Objects.set(key, bytes);
			return null;
		},
		get: async (key: string) => ({
			arrayBuffer: async () => state.r2Objects.get(key)?.buffer,
		}),
	};
}
