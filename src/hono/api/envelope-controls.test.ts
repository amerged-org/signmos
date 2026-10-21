import {
	auditEvents,
	emailSendRecords,
	envelopeRecipients,
	envelopes,
	finalDocuments,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	recipientsTable: null as unknown,
	tokensTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	finalDocumentsTable: null as unknown,
	auditEventsTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	envelopes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			status: "sent",
			createdBy: "sender@example.com",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
			sentBy: "sender@example.com",
			sentAt: new Date("2026-05-20T07:05:00.000Z"),
		},
	] as Array<Record<string, unknown>>,
	recipients: [
		{
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "sent",
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
		},
	] as Array<Record<string, unknown>>,
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
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf",
			version: 1,
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "sender@example.com",
			uploadedAt: new Date("2026-05-20T07:01:00.000Z"),
		},
	] as Array<Record<string, unknown>>,
	finalDocuments: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	emailSendRecords: [] as Array<Record<string, unknown>>,
	deletedKeys: [] as string[],
}));

function selectRows(table: unknown): Array<Record<string, unknown>> {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.tokensTable) return state.tokens;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.finalDocumentsTable) return state.finalDocuments;
	if (table === state.auditEventsTable) return state.auditEvents;
	if (table === state.emailSendRecordsTable) return state.emailSendRecords;
	return [];
}

function insertRows(table: unknown, rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row) => ({
		createdAt: new Date("2026-05-20T08:00:00.000Z"),
		...row,
	}));
	if (table === state.auditEventsTable) state.auditEvents.push(...inserted);
	if (table === state.emailSendRecordsTable) state.emailSendRecords.push(...inserted);
	return inserted;
}

function updateRows(table: unknown, value: Record<string, unknown>) {
	if (table === state.envelopesTable) {
		state.envelopes = state.envelopes.map((row) => ({ ...row, ...value }));
	}
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
	}),
}));

describe("envelope controls", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.tokensTable = signerTokens;
		state.sourceDocumentsTable = sourceDocuments;
		state.finalDocumentsTable = finalDocuments;
		state.auditEventsTable = auditEvents;
		state.emailSendRecordsTable = emailSendRecords;
		state.envelopes[0] = { ...state.envelopes[0], status: "sent" };
		state.finalDocuments.length = 0;
		state.auditEvents.length = 0;
		state.emailSendRecords.length = 0;
		state.deletedKeys.length = 0;
	});

	it("lets the sender cancel an active envelope and blocks further signing", async () => {
		// #20 assumptions before RED:
		// - Cancel uses the existing terminal `expired` status because there is no `canceled` status.
		// - Action records and fallback emails are persisted; no external mail provider is called.
		// - Structured logs are represented by immutable audit rows in this codebase.
		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/actions",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-internal-user-id": "sender@example.com",
					"x-now": "2026-05-20T08:00:00.000Z",
				},
				body: JSON.stringify({ action: "cancel" }),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				action: "cancel",
				status: "expired",
				allowedActions: ["delete"],
			},
		});
		expect(state.envelopes[0]?.status).toBe("expired");
		expect(state.auditEvents).toEqual([
			expect.objectContaining({
				eventType: "envelope.canceled",
				message: "sender@example.com",
			}),
		]);
		expect(state.emailSendRecords).toEqual([
			expect.objectContaining({
				email: "ada@example.com",
				kind: "cancel",
				fallbackUrl: "/signing/valid-token",
			}),
		]);

		const signing = await apiHono.request("/api/signing/valid-token", {
			headers: { "x-now": "2026-05-20T08:01:00.000Z" },
		});
		expect(signing.status).toBe(410);
		await expect(signing.json()).resolves.toEqual({
			error: {
				code: "ENVELOPE_EXPIRED",
				message: "This signing link is no longer active",
			},
		});
	});

	it("lets the sender delete an envelope and revokes stored PDF access", async () => {
		state.envelopes[0] = { ...state.envelopes[0], status: "completed" };
		state.finalDocuments.push({
			id: "90000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/final.pdf",
			sha256: "b".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			createdAt: new Date("2026-05-20T08:00:00.000Z"),
		});

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/actions",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-internal-user-id": "sender@example.com",
					"x-now": "2026-05-20T08:10:00.000Z",
				},
				body: JSON.stringify({ action: "delete" }),
			},
			{
				DOCUMENTS_BUCKET: {
					delete: async (keys: string | string[]) => {
						state.deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
					},
				},
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				action: "delete",
				status: "deleted",
				allowedActions: [],
			},
		});
		expect(state.deletedKeys).toEqual([
			"envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf",
			"envelopes/00000000-0000-4000-8000-000000000001/final.pdf",
		]);
		expect(state.auditEvents).toEqual([
			expect.objectContaining({
				eventType: "envelope.deleted",
				message: "sender@example.com",
			}),
		]);
		expect(state.emailSendRecords).toEqual([
			expect.objectContaining({
				email: "ada@example.com",
				kind: "delete",
				fallbackUrl: "/signing/valid-token",
			}),
		]);

		const signing = await apiHono.request("/api/signing/valid-token", {
			headers: { "x-now": "2026-05-20T08:11:00.000Z" },
		});
		expect(signing.status).toBe(410);
		await expect(signing.json()).resolves.toEqual({
			error: {
				code: "ENVELOPE_DELETED",
				message: "This document was deleted by the sender",
			},
		});
	});

	it("reports retention eligibility ninety days after completed or expired terminal states", async () => {
		state.envelopes[0] = { ...state.envelopes[0], status: "completed" };
		state.finalDocuments.push({
			id: "90000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/final.pdf",
			sha256: "b".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			createdAt: new Date("2026-05-20T08:00:00.000Z"),
		});

		const completed = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/retention",
			{
				headers: {
					"x-internal-user-id": "sender@example.com",
					"x-now": "2026-08-18T08:00:01.000Z",
				},
			},
		);

		expect(completed.status).toBe(200);
		await expect(completed.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				status: "completed",
				retentionEligibleAt: "2026-08-18T08:00:00.000Z",
				retentionEligible: true,
			},
		});

		state.envelopes[0] = { ...state.envelopes[0], status: "expired" };
		state.finalDocuments.length = 0;
		state.auditEvents.push({
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: null,
			eventType: "envelope.expired",
			message: "sender@example.com",
			createdAt: new Date("2026-05-20T07:30:00.000Z"),
		});

		const expired = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/retention",
			{
				headers: {
					"x-internal-user-id": "sender@example.com",
					"x-now": "2026-08-18T07:29:59.000Z",
				},
			},
		);

		expect(expired.status).toBe(200);
		await expect(expired.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				status: "expired",
				retentionEligibleAt: "2026-08-18T07:30:00.000Z",
				retentionEligible: false,
			},
		});
	});
});
