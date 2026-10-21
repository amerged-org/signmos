import {
	auditEvents,
	emailSendRecords,
	envelopeRecipients,
	envelopes,
	signerTokens,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	recipientsTable: null as unknown,
	tokensTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	auditEventsTable: null as unknown,
	envelopes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			status: "sent",
			createdBy: "sender@example.com",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
			sentBy: "sender_123",
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
	tokens: [
		{
			id: "30000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			token: "verified-token",
			status: "active",
			expiresAt: new Date("2026-05-27T07:03:00.000Z"),
			verifiedAt: new Date("2026-05-20T07:04:00.000Z"),
			createdAt: new Date("2026-05-20T07:03:00.000Z"),
		},
	],
	emailSends: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
}));

function selectRows(table: unknown) {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.tokensTable) return state.tokens;
	if (table === state.emailSendRecordsTable) return state.emailSends;
	if (table === state.auditEventsTable) return state.auditEvents;
	return [];
}

function insertRows(table: unknown, rows: Array<Record<string, unknown>>) {
	if (table === state.emailSendRecordsTable) state.emailSends.push(...rows);
	if (table === state.auditEventsTable) state.auditEvents.push(...rows);
	return rows;
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
						set: (value: Record<string, unknown>) => ({
							where: async () => {
								if (table === state.envelopesTable) {
									state.envelopes = state.envelopes.map((envelope) => ({ ...envelope, ...value }));
								}
								if (table === state.recipientsTable) {
									state.recipients = state.recipients.map((recipient) => ({
										...recipient,
										...value,
									}));
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

describe("partner change requests", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.tokensTable = signerTokens;
		state.emailSendRecordsTable = emailSendRecords;
		state.auditEventsTable = auditEvents;
		state.emailSends.length = 0;
		state.auditEvents.length = 0;
		state.envelopes[0] = {
			id: "00000000-0000-4000-8000-000000000001",
			status: "sent",
			createdBy: "sender@example.com",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
			sentBy: "sender_123",
			sentAt: new Date("2026-05-20T07:04:00.000Z"),
		};
		state.recipients[0] = {
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "sent",
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
		};
	});

	it("moves a sent envelope to changes requested and notifies the sender", async () => {
		// Assumptions for issue #18 RED:
		// - Change requests use POST /api/signing/:token/change-request and require a verified partner token.
		// - A change request keeps the recipient in sent state and moves the envelope to changes_requested.
		// - The sender notification is represented by an email_send_records row with a fallback upload URL.
		// - Comment history beyond the single request comment is intentionally out of scope.
		const response = await apiHono.request("/api/signing/verified-token/change-request", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-20T08:00:00.000Z",
			},
			body: JSON.stringify({ comment: "Please update the billing address." }),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				recipientStatus: "sent",
				envelopeStatus: "changes_requested",
				allowedActions: ["upload_revised_source_pdf", "cancel", "expire", "delete"],
			},
		});
		expect(state.envelopes[0]?.status).toBe("changes_requested");
		expect(state.emailSends).toEqual([
			expect.objectContaining({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				tokenId: "30000000-0000-4000-8000-000000000001",
				email: "sender@example.com",
				kind: "change_request",
				fallbackUrl:
					"/source-pdf-upload?envelopeId=00000000-0000-4000-8000-000000000001&changeRequestComment=Please+update+the+billing+address.",
			}),
		]);
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "partner.change_requested",
					recipientId: "20000000-0000-4000-8000-000000000001",
					message: "Please update the billing address.",
				}),
				expect.objectContaining({
					eventType: "sender.change_request.notified",
					message: "sender@example.com",
				}),
			]),
		);
	});

	it("delivers a change request email through Resend when configured", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "resend-email-1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const response = await apiHono.request(
			"/api/signing/verified-token/change-request",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-now": "2026-05-20T08:00:00.000Z",
				},
				body: JSON.stringify({ comment: "Please update the billing address." }),
			},
			{
				APP_BASE_URL: "https://signmos.example",
				RESEND_API_KEY: "re_test",
				RESEND_FROM_EMAIL: "Signmos <sign@signmos.example>",
				RESEND_REPLY_TO_EMAIL: "support@signmos.example",
			},
		);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.resend.com/emails",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "Bearer re_test",
					"content-type": "application/json",
				}),
				body: expect.stringContaining("sender@example.com"),
			}),
		);
		const [, init] = fetchMock.mock.calls[0] ?? [];
		const body = JSON.parse(String(init?.body)) as {
			to: string[];
			subject: string;
			html: string;
			text: string;
		};
		expect(body.to).toEqual(["sender@example.com"]);
		expect(body.subject).toBe("Änderungen an deinem Vertrag angefragt · amerged Sign");
		expect(body.html).toContain("https://signmos.example/source-pdf-upload");
		expect(body.text).toContain("Please update the billing address.");
		fetchMock.mockRestore();
	});

	it("requires a change request comment", async () => {
		const response = await apiHono.request("/api/signing/verified-token/change-request", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-20T08:00:00.000Z",
			},
			body: JSON.stringify({ comment: "" }),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "INVALID_CHANGE_REQUEST",
				message: "Change request comment is required",
			},
		});
		expect(state.envelopes[0]?.status).toBe("sent");
		expect(state.emailSends).toHaveLength(0);
		expect(state.auditEvents).toHaveLength(0);
	});

	it("blocks completion while the sender revision is pending", async () => {
		state.envelopes[0] = { ...state.envelopes[0], status: "changes_requested" };

		const response = await apiHono.request("/api/signing/verified-token/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-20T08:05:00.000Z",
			},
			body: JSON.stringify({ signatureName: "Ada Lovelace", date: "2026-05-20" }),
		});

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "SIGNING_BLOCKED",
				message: "Envelope is waiting for sender revision",
				allowedActions: ["upload_revised_source_pdf", "cancel", "expire", "delete"],
			},
		});
	});
});
