import {
	auditEvents,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	signerTokens,
} from "@/db/envelope";
import { historySecurityEventTypes } from "@/db/history-access/security-audit";
import { apiHono } from "@/hono/api";

const envelopeId = "00000000-0000-4000-8000-000000000001";
const senderRecipientId = "20000000-0000-4000-8000-000000000001";
const partnerRecipientId = "20000000-0000-4000-8000-000000000002";
const finalDocumentToken = "90000000-0000-4000-8000-000000000001";
const finalR2Key = `envelopes/${envelopeId}/final.pdf`;

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	recipientsTable: null as unknown,
	fieldsTable: null as unknown,
	fieldValuesTable: null as unknown,
	auditEventsTable: null as unknown,
	finalDocumentsTable: null as unknown,
	tokensTable: null as unknown,
	envelopes: [] as Array<Record<string, unknown>>,
	recipients: [] as Array<Record<string, unknown>>,
	fields: [] as Array<Record<string, unknown>>,
	fieldValues: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	finalDocuments: [] as Array<Record<string, unknown>>,
	tokens: [] as Array<Record<string, unknown>>,
	r2Objects: new Map<string, Uint8Array>(),
}));

function selectRows(table: unknown) {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.fieldValuesTable) return state.fieldValues;
	if (table === state.auditEventsTable) return state.auditEvents;
	if (table === state.finalDocumentsTable) return state.finalDocuments;
	if (table === state.tokensTable) return state.tokens;
	return [];
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
				},
				selectRows,
			),
	};
});

describe("completed document access", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.fieldsTable = envelopeFields;
		state.fieldValuesTable = fieldValues;
		state.auditEventsTable = auditEvents;
		state.finalDocumentsTable = finalDocuments;
		state.tokensTable = signerTokens;
		state.envelopes = [
			{
				id: envelopeId,
				status: "completed",
				createdBy: "sender@example.com",
				createdAt: new Date("2026-05-20T07:00:00.000Z"),
				sentBy: "sender@example.com",
				sentAt: new Date("2026-05-20T07:04:00.000Z"),
			},
		];
		state.recipients = [
			{
				id: senderRecipientId,
				envelopeId,
				name: "Sender Example",
				email: "sender@example.com",
				status: "completed",
				createdAt: new Date("2026-05-20T07:01:00.000Z"),
			},
			{
				id: partnerRecipientId,
				envelopeId,
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "completed",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
		];
		state.fields = [
			{
				id: "50000000-0000-4000-8000-000000000001",
				envelopeId,
				recipientId: senderRecipientId,
				type: "date",
				page: 1,
				x: 300,
				y: 144,
				width: 120,
				height: 32,
				createdAt: new Date("2026-05-20T07:05:00.000Z"),
			},
			{
				id: "50000000-0000-4000-8000-000000000002",
				envelopeId,
				recipientId: partnerRecipientId,
				type: "date",
				page: 1,
				x: 300,
				y: 244,
				width: 120,
				height: 32,
				createdAt: new Date("2026-05-20T07:05:00.000Z"),
			},
		];
		state.fieldValues = [
			{
				id: "80000000-0000-4000-8000-000000000001",
				envelopeId,
				recipientId: senderRecipientId,
				fieldId: "50000000-0000-4000-8000-000000000001",
				value: "2026-05-20",
				completedAt: new Date("2026-05-20T07:06:00.000Z"),
			},
			{
				id: "80000000-0000-4000-8000-000000000002",
				envelopeId,
				recipientId: partnerRecipientId,
				fieldId: "50000000-0000-4000-8000-000000000002",
				value: "2026-05-21",
				completedAt: new Date("2026-05-21T09:10:00.000Z"),
			},
		];
		state.auditEvents = [
			{
				id: "a1",
				envelopeId,
				recipientId: null,
				eventType: "envelope.sent",
				message: "sender@example.com",
				createdAt: new Date("2026-05-20T07:04:00.000Z"),
			},
			{
				id: "a2",
				envelopeId,
				recipientId: partnerRecipientId,
				eventType: "partner.verified",
				message: "ada@example.com",
				createdAt: new Date("2026-05-20T07:30:00.000Z"),
			},
			{
				id: "a3",
				envelopeId,
				recipientId: partnerRecipientId,
				eventType: "partner.signing.viewed",
				message: null,
				createdAt: new Date("2026-05-21T09:00:00.000Z"),
			},
			{
				id: "a4",
				envelopeId,
				recipientId: partnerRecipientId,
				eventType: "field.value.completed",
				message: "Ada Lovelace",
				createdAt: new Date("2026-05-21T09:10:00.000Z"),
			},
			{
				id: "a5",
				envelopeId,
				recipientId: partnerRecipientId,
				eventType: "recipient.completed",
				message: "Ada Lovelace",
				createdAt: new Date("2026-05-21T09:10:00.000Z"),
			},
			{
				id: "a6",
				envelopeId,
				recipientId: partnerRecipientId,
				eventType: "partner.link.expired",
				message: "ada@example.com",
				createdAt: new Date("2026-05-30T00:00:00.000Z"),
			},
		];
		const finalPdf = new TextEncoder().encode("%PDF-1.4\ncompleted artifact\n%%EOF");
		state.finalDocuments = [
			{
				id: finalDocumentToken,
				envelopeId,
				r2Key: finalR2Key,
				sha256: "b".repeat(64),
				byteSize: finalPdf.byteLength,
				contentType: "application/pdf",
				createdAt: new Date("2026-05-21T09:11:00.000Z"),
			},
		];
		state.tokens = [
			{
				id: "30000000-0000-4000-8000-000000000001",
				envelopeId,
				recipientId: partnerRecipientId,
				token: "valid-token",
				status: "active",
				expiresAt: new Date("2026-05-22T07:03:00.000Z"),
				verifiedAt: null,
				createdAt: new Date("2026-05-20T07:03:00.000Z"),
			},
		];
		state.r2Objects.clear();
		state.r2Objects.set(finalR2Key, finalPdf);
	});

	it("returns completed view data with download, parties, signed dates, status, and public history", async () => {
		// #27 assumptions before RED:
		// - The final document id is the bearer final-download token.
		// - The completed-document API returns the UI contract instead of raw audit rows.
		// - Security/verification and field-level technical audit rows are filtered from normal history.
		const response = await apiHono.request(`/api/final-documents/${finalDocumentToken}`);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: {
				status: string;
				finalPdf: { downloadUrl: string };
				parties: Array<{ name: string; email: string; signedDate: string | null }>;
				history: Array<{ type: string; title: string; occurredAt: string }>;
			};
		};
		expect(body.data.status).toBe("completed");
		expect(body.data.finalPdf.downloadUrl).toBe(`/api/final-documents/${finalDocumentToken}/pdf`);
		expect(body.data.parties).toEqual([
			expect.objectContaining({
				name: "Sender Example",
				email: "sender@example.com",
				signedDate: "2026-05-20",
			}),
			expect.objectContaining({
				name: "Ada Lovelace",
				email: "ada@example.com",
				signedDate: "2026-05-21",
			}),
		]);
		expect(body.data.history).toEqual([
			expect.objectContaining({ type: "sent", title: "Envelope sent" }),
			expect.objectContaining({ type: "viewed", title: "Ada Lovelace viewed the document" }),
			expect.objectContaining({ type: "signed", title: "Ada Lovelace signed" }),
		]);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("partner.verified");
		expect(serialized).not.toContain("field.value.completed");
		expect(serialized).not.toContain("partner.link.expired");
	});

	it("orders the public history by timestamp without initializing the locale collator", async () => {
		// ISO timestamps order by code unit. localeCompare would initialize ICU, which costs CPU on a
		// cold Worker isolate that has 50 ms for the whole request.
		state.auditEvents.reverse();
		const collator = vi.spyOn(String.prototype, "localeCompare");
		try {
			const response = await apiHono.request(`/api/final-documents/${finalDocumentToken}`);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { history: Array<{ type: string }> } };
			expect(body.data.history.map((event) => event.type)).toEqual(["sent", "viewed", "signed"]);
			expect(collator).not.toHaveBeenCalled();
		} finally {
			collator.mockRestore();
		}
	});

	it("filters every My documents technical event while retaining normal lifecycle history", async () => {
		state.auditEvents.push(
			...historySecurityEventTypes.map((eventType, index) => ({
				id: `history-${index}`,
				envelopeId,
				recipientId: null,
				eventType,
				message: "safe-reference",
				createdAt: new Date(`2026-05-21T10:${String(index).padStart(2, "0")}:00.000Z`),
			})),
		);

		const response = await apiHono.request(`/api/final-documents/${finalDocumentToken}`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { history: Array<{ type: string }> } };
		expect(body.data.history.map((event) => event.type)).toEqual(["sent", "viewed", "signed"]);
		expect(JSON.stringify(body)).not.toContain("history.");
	});

	it("downloads the final PDF with only the final document token", async () => {
		const bucket = {
			get: async (key: string) => ({
				arrayBuffer: async () => state.r2Objects.get(key)?.buffer,
			}),
		};

		const response = await apiHono.request(
			`/api/final-documents/${finalDocumentToken}/pdf`,
			undefined,
			{ DOCUMENTS_BUCKET: bucket },
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(new TextDecoder().decode(await response.arrayBuffer())).toContain("completed artifact");
	});

	it("routes a completed signing link to the completed-document view without signer verification", async () => {
		const response = await apiHono.request("/api/signing/valid-token", {
			headers: { "x-now": "2026-05-21T09:12:00.000Z" },
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				completedDocument: {
					url: "/completed-documents/valid-token",
					downloadUrl: "/api/final-documents/valid-token/pdf",
				},
			},
		});
	});
});
