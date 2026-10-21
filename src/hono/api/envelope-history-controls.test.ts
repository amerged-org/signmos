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
import { apiHono } from "@/hono/api";

const currentEnvelopeId = "00000000-0000-4000-8000-000000000001";
const targetEnvelopeId = "00000000-0000-4000-8000-000000000002";
const partnerEnvelopeId = "00000000-0000-4000-8000-000000000003";
const recipientId = "20000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	recipientsTable: null as unknown,
	senderVerificationTokensTable: null as unknown,
	tokensTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	finalDocumentsTable: null as unknown,
	auditEventsTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	envelopes: [] as Array<Record<string, unknown>>,
	recipients: [] as Array<Record<string, unknown>>,
	senderVerificationTokens: [] as Array<Record<string, unknown>>,
	tokens: [] as Array<Record<string, unknown>>,
	sourceDocuments: [] as Array<Record<string, unknown>>,
	finalDocuments: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	emailSendRecords: [] as Array<Record<string, unknown>>,
	deletedKeys: [] as string[],
}));

function selectRows(table: unknown): Array<Record<string, unknown>> {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.senderVerificationTokensTable) return state.senderVerificationTokens;
	if (table === state.tokensTable) return state.tokens;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.finalDocumentsTable) return state.finalDocuments;
	if (table === state.auditEventsTable) return state.auditEvents;
	if (table === state.emailSendRecordsTable) return state.emailSendRecords;
	return [];
}

function insertRows(table: unknown, rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row) => ({
		createdAt: new Date("2026-05-21T10:00:00.000Z"),
		...row,
	}));
	if (table === state.auditEventsTable) state.auditEvents.push(...inserted);
	if (table === state.emailSendRecordsTable) state.emailSendRecords.push(...inserted);
	return inserted;
}

function updateRows(table: unknown, value: Record<string, unknown>) {
	if (table === state.envelopesTable) {
		state.envelopes = state.envelopes.map((row, index) =>
			index === 0 ? { ...row, ...value } : row,
		);
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

describe("creator controls from confirmed-email history", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.senderVerificationTokensTable = senderVerificationTokens;
		state.tokensTable = signerTokens;
		state.sourceDocumentsTable = sourceDocuments;
		state.finalDocumentsTable = finalDocuments;
		state.auditEventsTable = auditEvents;
		state.emailSendRecordsTable = emailSendRecords;
		state.recipients = [
			{
				id: recipientId,
				envelopeId: targetEnvelopeId,
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "sent",
				createdAt: new Date("2026-05-20T09:00:00.000Z"),
			},
		];
		state.senderVerificationTokens = [
			{
				id: "10000000-0000-4000-8000-000000000001",
				envelopeId: currentEnvelopeId,
				name: "Ada Lovelace",
				email: "ADA@Example.COM",
				token: "current-history-session",
				status: "verified",
				expiresAt: new Date("2026-05-21T09:30:00.000Z"),
				verifiedAt: new Date("2026-05-21T09:05:00.000Z"),
				createdAt: new Date("2026-05-21T09:00:00.000Z"),
			},
		];
		state.tokens = [
			{
				id: "30000000-0000-4000-8000-000000000001",
				envelopeId: targetEnvelopeId,
				recipientId,
				token: "target-signer-token",
				status: "active",
				expiresAt: new Date("2026-05-28T09:00:00.000Z"),
				verifiedAt: null,
				createdAt: new Date("2026-05-20T09:05:00.000Z"),
			},
		];
		state.sourceDocuments = [
			{
				id: "40000000-0000-4000-8000-000000000001",
				envelopeId: targetEnvelopeId,
				r2Key: `envelopes/${targetEnvelopeId}/source-v1.pdf`,
				version: 1,
				sha256: "a".repeat(64),
				byteSize: 10,
				contentType: "application/pdf",
				uploadedBy: "ada@example.com",
				uploadedAt: new Date("2026-05-20T09:00:00.000Z"),
			},
		];
		state.finalDocuments = [];
		state.auditEvents = [];
		state.emailSendRecords = [];
		state.deletedKeys = [];
	});

	it("allows the confirmed creator session to cancel an older owned history row", async () => {
		// #34 assumptions before RED:
		// - A current verified sender session proves normalized email ownership for history controls.
		// - Existing lifecycle code remains the authority for state transitions, audit rows, and notifications.
		state.envelopes = [
			envelope(targetEnvelopeId, "sent", "ada@example.com"),
			envelope(currentEnvelopeId, "draft", "ada@example.com"),
		];

		const response = await apiHono.request(`/api/envelopes/${targetEnvelopeId}/actions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-sender-session-token": "current-history-session",
				"x-now": "2026-05-21T09:10:00.000Z",
			},
			body: JSON.stringify({ action: "cancel" }),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: targetEnvelopeId,
				action: "cancel",
				status: "expired",
				allowedActions: ["delete"],
			},
		});
		expect(state.envelopes[0]?.status).toBe("expired");
		expect(state.auditEvents).toEqual([
			expect.objectContaining({
				envelopeId: targetEnvelopeId,
				eventType: "envelope.canceled",
				message: "ada@example.com",
			}),
		]);
		expect(state.emailSendRecords).toEqual([
			expect.objectContaining({
				envelopeId: targetEnvelopeId,
				email: "ada@example.com",
				kind: "cancel",
			}),
		]);
	});

	it("allows the confirmed creator session to delete an older owned history row", async () => {
		state.envelopes = [
			envelope(targetEnvelopeId, "draft", "ada@example.com"),
			envelope(currentEnvelopeId, "draft", "ada@example.com"),
		];

		const response = await apiHono.request(
			`/api/envelopes/${targetEnvelopeId}/actions`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-sender-session-token": "current-history-session",
					"x-now": "2026-05-21T09:10:00.000Z",
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
				envelopeId: targetEnvelopeId,
				action: "delete",
				status: "deleted",
				allowedActions: [],
			},
		});
		expect(state.deletedKeys).toEqual([`envelopes/${targetEnvelopeId}/source-v1.pdf`]);
		expect(state.auditEvents).toEqual([
			expect.objectContaining({
				envelopeId: targetEnvelopeId,
				eventType: "envelope.deleted",
				message: "ada@example.com",
			}),
		]);
	});

	it.each([
		"cancel",
		"delete",
	] as const)("rejects partner signer direct %s attempts against another creator's envelope", async (action) => {
		state.envelopes = [
			envelope(partnerEnvelopeId, "sent", "sender@example.com"),
			envelope(currentEnvelopeId, "draft", "ada@example.com"),
		];
		state.recipients = [
			{
				id: recipientId,
				envelopeId: partnerEnvelopeId,
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "sent",
				createdAt: new Date("2026-05-20T09:00:00.000Z"),
			},
		];

		const response = await apiHono.request(`/api/envelopes/${partnerEnvelopeId}/actions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-sender-session-token": "current-history-session",
				"x-now": "2026-05-21T09:10:00.000Z",
			},
			body: JSON.stringify({ action }),
		});

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "CREATOR_CONTROL_FORBIDDEN",
				message: "Only the envelope creator can cancel or delete this envelope",
			},
		});
		expect(state.envelopes[0]?.status).toBe("sent");
		expect(state.auditEvents).toEqual([]);
		expect(state.emailSendRecords).toEqual([]);
	});
});

function envelope(id: string, status: string, createdBy: string): Record<string, unknown> {
	return {
		id,
		status,
		signingMode: "only_me",
		createdBy,
		createdAt: new Date("2026-05-20T09:00:00.000Z"),
		sentBy: createdBy,
		sentAt: new Date("2026-05-20T09:05:00.000Z"),
	};
}
