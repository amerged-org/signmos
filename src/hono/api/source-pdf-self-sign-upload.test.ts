import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	idempotencyRecords,
	senderVerificationTokens,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureBytes } from "@/test/pdf-fixtures";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	idempotencyTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	senderVerificationTokensTable: null as unknown,
	recipientsTable: null as unknown,
	fieldsTable: null as unknown,
	signerTokensTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	auditEventsTable: null as unknown,
	envelopes: [] as Array<Record<string, unknown>>,
	idempotencyRecords: [] as Array<Record<string, unknown>>,
	sourceDocuments: [] as Array<Record<string, unknown>>,
	senderVerificationTokens: [] as Array<Record<string, unknown>>,
	recipients: [] as Array<Record<string, unknown>>,
	fields: [] as Array<Record<string, unknown>>,
	signerTokens: [] as Array<Record<string, unknown>>,
	emailSendRecords: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	r2Objects: new Map<string, Uint8Array>(),
}));

function selectRows(table: unknown): Array<Record<string, unknown>> {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.idempotencyTable) return state.idempotencyRecords;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.senderVerificationTokensTable) return state.senderVerificationTokens;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.signerTokensTable) return state.signerTokens;
	if (table === state.emailSendRecordsTable) return state.emailSendRecords;
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
			id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			uploadedAt: new Date("2026-05-21T09:10:00.000Z"),
			...row,
		}));
		state.sourceDocuments.push(...inserted);
		return inserted;
	}
	if (table === state.recipientsTable) {
		const inserted = rows.map((row, index) => ({
			id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			createdAt: new Date("2026-05-21T09:11:00.000Z"),
			...row,
		}));
		state.recipients.push(...inserted);
		return inserted;
	}
	if (table === state.fieldsTable) {
		const inserted = rows.map((row, index) => ({
			id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			createdAt: new Date("2026-05-21T09:12:00.000Z"),
			...row,
		}));
		state.fields.push(...inserted);
		return inserted;
	}
	if (table === state.signerTokensTable) {
		const inserted = rows.map((row, index) => ({
			id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			createdAt: new Date("2026-05-21T09:13:00.000Z"),
			...row,
		}));
		state.signerTokens.push(...inserted);
		return inserted;
	}
	if (table === state.emailSendRecordsTable) {
		const inserted = rows.map((row, index) => ({
			id: `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			sentAt: new Date("2026-05-21T09:14:00.000Z"),
			...row,
		}));
		state.emailSendRecords.push(...inserted);
		return inserted;
	}
	if (table === state.auditEventsTable) {
		state.auditEvents.push(...rows);
		return rows;
	}
	return rows;
}

function updateRows(table: unknown, value: Record<string, unknown>) {
	if (table === state.envelopesTable) {
		state.envelopes = state.envelopes.map((row) => ({ ...row, ...value }));
	}
	if (table === state.recipientsTable) {
		state.recipients = state.recipients.map((row) => ({ ...row, ...value }));
	}
	return [];
}

function storeR2Object(key: string, value: ArrayBuffer | ArrayBufferView) {
	const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
	state.r2Objects.set(key, bytes);
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
	}),
}));

describe("source PDF self-sign upload API", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.idempotencyTable = idempotencyRecords;
		state.sourceDocumentsTable = sourceDocuments;
		state.senderVerificationTokensTable = senderVerificationTokens;
		state.recipientsTable = envelopeRecipients;
		state.fieldsTable = envelopeFields;
		state.signerTokensTable = signerTokens;
		state.emailSendRecordsTable = emailSendRecords;
		state.auditEventsTable = auditEvents;
		state.envelopes = [
			{
				id: "00000000-0000-4000-8000-000000000001",
				status: "draft",
				signingMode: "only_me",
				createdBy: "ada@example.com",
				createdAt: new Date("2026-05-21T09:00:00.000Z"),
				sentBy: null,
				sentAt: null,
			},
		];
		state.senderVerificationTokens = [
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
		];
		state.idempotencyRecords.length = 0;
		state.sourceDocuments.length = 0;
		state.recipients.length = 0;
		state.fields.length = 0;
		state.signerTokens.length = 0;
		state.emailSendRecords.length = 0;
		state.auditEvents.length = 0;
		state.r2Objects.clear();
	});

	it("prepares default last-page fields and a direct signing link after verified upload", async () => {
		// Assumptions for issue #30 RED:
		// - Issue #29 already established signingMode=only_me plus verified sender sessions.
		// - A detected PDF page count provides the default-field page; unknown counts fall back to page 1.
		// - Self-signing uses fixed default field geometry in this slice, without exposing adjustment controls.
		// - The internal envelope can become sent so existing signing endpoints work, but no visible send action is required.
		const pdfBytes = pdfFixtureBytes("Self-sign agreement", 3);

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf",
			{
				method: "POST",
				headers: {
					"x-sender-session-token": "verified-sender-token",
					"x-now": "2026-05-21T09:10:00.000Z",
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
		const body = (await response.json()) as {
			data: {
				selfSign: {
					recipientId: string;
					signingUrl: string;
					fieldCount: number;
					fieldPage: number;
				};
			};
		};
		expect(body.data.selfSign).toEqual({
			recipientId: "30000000-0000-4000-8000-000000000001",
			signingUrl: expect.stringMatching(/^\/signing\/.+/),
			fieldCount: 2,
			fieldPage: 3,
		});
		expect(state.recipients).toEqual([
			expect.objectContaining({
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "sent",
			}),
		]);
		expect(state.fields).toEqual([
			expect.objectContaining({ type: "signature", page: 3, x: 360, y: 628 }),
			expect.objectContaining({ type: "date", page: 3, x: 420, y: 688 }),
		]);
		expect(state.signerTokens).toEqual([
			expect.objectContaining({
				recipientId: "30000000-0000-4000-8000-000000000001",
				verifiedAt: new Date("2026-05-21T09:10:00.000Z"),
			}),
		]);
		expect(state.emailSendRecords).toEqual([
			expect.objectContaining({
				kind: "sender_signing",
				email: "ada@example.com",
				fallbackUrl: body.data.selfSign.signingUrl,
			}),
		]);
		expect(state.envelopes[0]).toEqual(
			expect.objectContaining({
				status: "sent",
				sentBy: "ada@example.com",
				sentAt: new Date("2026-05-21T09:10:00.000Z"),
			}),
		);
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "source_pdf.uploaded" }),
				expect.objectContaining({ eventType: "self_sign.default_fields_created" }),
				expect.objectContaining({ eventType: "self_sign.prepared" }),
			]),
		);
	});
});
