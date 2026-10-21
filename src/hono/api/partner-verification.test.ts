import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	recipientsTable: null as unknown,
	fieldsTable: null as unknown,
	tokensTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	auditEventsTable: null as unknown,
	envelopes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			status: "draft",
			createdBy: "sender@example.com",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
			sentBy: null as string | null,
			sentAt: null as Date | null,
		},
	],
	sourceDocuments: [
		{
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source.pdf",
			version: 1,
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "sender@example.com",
			uploadedAt: new Date("2026-05-20T07:01:00.000Z"),
		},
	],
	recipients: [
		{
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "pending",
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
	],
	tokens: [] as Array<Record<string, unknown>>,
	emailSends: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
}));

function selectRows(table: unknown) {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.tokensTable) return state.tokens;
	if (table === state.emailSendRecordsTable) return state.emailSends;
	if (table === state.auditEventsTable) return state.auditEvents;
	return [];
}

function insertRows(table: unknown, rows: Array<Record<string, unknown>>) {
	if (table === state.tokensTable) return insertTokens(rows);
	if (table === state.emailSendRecordsTable) return pushRows(state.emailSends, rows);
	if (table === state.auditEventsTable) return pushRows(state.auditEvents, rows);
	return rows;
}

function insertTokens(rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row, index) => ({
		id: `30000000-0000-4000-8000-${String(state.tokens.length + index + 1).padStart(12, "0")}`,
		...row,
		createdAt: new Date("2026-05-20T07:03:00.000Z"),
	}));
	state.tokens.push(...inserted);
	return inserted;
}

function pushRows(target: Array<Record<string, unknown>>, rows: Array<Record<string, unknown>>) {
	target.push(...rows);
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
								if (table === state.tokensTable) {
									state.tokens = state.tokens.map((token) => ({ ...token, ...value }));
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

describe("partner verification delivery", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.sourceDocumentsTable = sourceDocuments;
		state.recipientsTable = envelopeRecipients;
		state.fieldsTable = envelopeFields;
		state.tokensTable = signerTokens;
		state.emailSendRecordsTable = emailSendRecords;
		state.auditEventsTable = auditEvents;
		state.tokens.length = 0;
		state.emailSends.length = 0;
		state.auditEvents.length = 0;
		state.envelopes[0] = {
			id: "00000000-0000-4000-8000-000000000001",
			status: "draft",
			createdBy: "sender@example.com",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
			sentBy: null,
			sentAt: null,
		};
		state.recipients[0] = {
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "pending",
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
		};
	});

	it("sends a prepared envelope as partner verification links with delivery metadata", async () => {
		// Assumptions for issue #17 RED:
		// - POST /api/envelopes/:id/actions with action=send remains the sender public boundary.
		// - Send creates one token per partner and emails a UI verification URL, not an API URL.
		// - The same token becomes a signing token only after GET /api/signing/verifications/:token.
		// - Delivery metadata is observable through email_send_records rows, including fallbackUrl.
		// - Resend itself is outside this slice; fallback links are the tested delivery output.
		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/actions",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "sender_123",
					"content-type": "application/json",
				},
				body: JSON.stringify({ action: "send" }),
			},
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: {
				verificationLinks: Array<{
					recipientId: string;
					email: string;
					token: string;
					url: string;
					expiresAt: string;
				}>;
			};
		};
		expect(body.data.verificationLinks).toEqual([
			{
				recipientId: "20000000-0000-4000-8000-000000000001",
				email: "ada@example.com",
				token: expect.any(String),
				url: expect.stringMatching(/^\/signing-verifications\//),
				expiresAt: expect.any(String),
			},
		]);
		expect(state.emailSends).toEqual([
			expect.objectContaining({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				email: "ada@example.com",
				kind: "partner_verification",
				fallbackUrl: body.data.verificationLinks[0]?.url,
			}),
		]);
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "envelope.sent", message: "sender_123" }),
				expect.objectContaining({
					eventType: "partner.verification.sent",
					recipientId: "20000000-0000-4000-8000-000000000001",
					message: "ada@example.com",
				}),
			]),
		);
	});

	it("requires partner email verification before signing access is granted", async () => {
		state.tokens.push({
			id: "30000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			token: "partner-token",
			status: "active",
			expiresAt: new Date("2026-05-27T07:03:00.000Z"),
			verifiedAt: null,
			createdAt: new Date("2026-05-20T07:03:00.000Z"),
		});

		const blocked = await apiHono.request("/api/signing/partner-token", {
			headers: { "x-now": "2026-05-20T08:00:00.000Z" },
		});
		expect(blocked.status).toBe(403);
		await expect(blocked.json()).resolves.toEqual({
			error: {
				code: "PARTNER_VERIFICATION_REQUIRED",
				message: "Partner email verification is required before signing",
				verificationUrl: "/signing-verifications/partner-token",
			},
		});

		const verified = await apiHono.request("/api/signing/verifications/partner-token", {
			headers: { "x-now": "2026-05-20T08:05:00.000Z" },
		});
		expect(verified.status).toBe(200);
		await expect(verified.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				status: "verified",
				signingLink: {
					token: "partner-token",
					url: "/signing/partner-token",
				},
				verifiedAt: "2026-05-20T08:05:00.000Z",
			},
		});

		const opened = await apiHono.request("/api/signing/partner-token", {
			headers: { "x-now": "2026-05-20T08:06:00.000Z" },
		});
		expect(opened.status).toBe(200);
		await expect(opened.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				signingMode: "me_and_another_signer",
				sourceDocument: {
					version: 1,
					contentType: "application/pdf",
					downloadUrl: "/api/signing/partner-token/source-pdf",
				},
				fields: [
					expect.objectContaining({
						id: "50000000-0000-4000-8000-000000000001",
						type: "signature",
					}),
				],
				previewFields: [
					expect.objectContaining({
						id: "50000000-0000-4000-8000-000000000001",
						recipientName: "Ada Lovelace",
						value: null,
						assignedToCurrentSigner: true,
					}),
				],
				signaturePreference: null,
			},
		});
		expect(state.tokens[0]?.verifiedAt).toEqual(new Date("2026-05-20T08:05:00.000Z"));
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "partner.verified", message: "ada@example.com" }),
				expect.objectContaining({ eventType: "partner.signing.viewed", message: null }),
			]),
		);
	});

	it("expires verification and signing links after seven days with stable audit events", async () => {
		state.tokens.push({
			id: "30000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			token: "expired-partner-token",
			status: "active",
			expiresAt: new Date("2026-05-27T07:03:00.000Z"),
			verifiedAt: null,
			createdAt: new Date("2026-05-20T07:03:00.000Z"),
		});

		const beforeBoundary = await apiHono.request(
			"/api/signing/verifications/expired-partner-token",
			{
				headers: { "x-now": "2026-05-27T07:02:59.999Z" },
			},
		);
		expect(beforeBoundary.status).toBe(200);

		const exactBoundary = await apiHono.request(
			"/api/signing/verifications/expired-partner-token",
			{
				headers: { "x-now": "2026-05-27T07:03:00.000Z" },
			},
		);
		expect(exactBoundary.status).toBe(410);
		await expect(exactBoundary.json()).resolves.toEqual({
			error: {
				code: "EXPIRED_PARTNER_VERIFICATION",
				message: "Partner verification token has expired",
			},
		});

		const signing = await apiHono.request("/api/signing/expired-partner-token", {
			headers: { "x-now": "2026-05-27T07:03:01.000Z" },
		});
		expect(signing.status).toBe(410);
		await expect(signing.json()).resolves.toEqual({
			error: {
				code: "EXPIRED_TOKEN",
				message: "Signing token has expired",
			},
		});
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "partner.link.expired",
					recipientId: "20000000-0000-4000-8000-000000000001",
					message: "expired-partner-token",
				}),
			]),
		);
	});

	it("treats repeated send as idempotent without duplicating delivery records", async () => {
		state.envelopes[0] = {
			...state.envelopes[0],
			status: "sent",
			sentBy: "sender_123",
			sentAt: new Date("2026-05-20T07:04:00.000Z"),
		};
		state.recipients[0] = { ...state.recipients[0], status: "sent" };
		state.tokens.push({
			id: "30000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			token: "existing-partner-token",
			status: "active",
			expiresAt: new Date("2026-05-27T07:03:00.000Z"),
			verifiedAt: null,
			createdAt: new Date("2026-05-20T07:03:00.000Z"),
		});
		state.emailSends.push({
			id: "40000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			tokenId: "30000000-0000-4000-8000-000000000001",
			email: "ada@example.com",
			kind: "partner_verification",
			fallbackUrl: "/signing-verifications/existing-partner-token",
			sentAt: new Date("2026-05-20T07:04:00.000Z"),
		});

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/actions",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "sender_123",
					"content-type": "application/json",
				},
				body: JSON.stringify({ action: "send" }),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				status: "sent",
				sentBy: "sender_123",
				tokenCount: 1,
				emailSendCount: 1,
				verificationLinks: [
					{
						recipientId: "20000000-0000-4000-8000-000000000001",
						email: "ada@example.com",
						token: "existing-partner-token",
						url: "/signing-verifications/existing-partner-token",
						expiresAt: "2026-05-27T07:03:00.000Z",
					},
				],
			},
		});
		expect(state.tokens).toHaveLength(1);
		expect(state.emailSends).toHaveLength(1);
	});
});
