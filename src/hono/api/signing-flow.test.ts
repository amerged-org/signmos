import { PDFDocument } from "pdf-lib";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	signatureProfiles,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureBytes } from "@/test/pdf-fixtures";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	recipientsTable: null as unknown,
	fieldsTable: null as unknown,
	tokensTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	fieldValuesTable: null as unknown,
	finalDocumentsTable: null as unknown,
	auditEventsTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	signatureProfilesTable: null as unknown,
	envelopes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			status: "sent",
			signingMode: "me_and_another_signer",
			createdBy: "user_123",
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
		{
			id: "20000000-0000-4000-8000-000000000002",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Grace Hopper",
			email: "grace@example.com",
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
	],
	sourceDocuments: [
		{
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf",
			version: 1,
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "sender_123",
			uploadedAt: new Date("2026-05-20T07:01:00.000Z"),
		},
	],
	fieldValues: [] as unknown[],
	finalDocuments: [] as Array<Record<string, unknown>>,
	auditEvents: [] as unknown[],
	emailSends: [] as Array<Record<string, unknown>>,
	signatureProfiles: [] as Array<Record<string, unknown>>,
}));

function selectRows(table: unknown) {
	if (table === state.tokensTable) return state.tokens;
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.fieldValuesTable) return state.fieldValues;
	if (table === state.finalDocumentsTable) return state.finalDocuments;
	if (table === state.emailSendRecordsTable) return state.emailSends;
	if (table === state.signatureProfilesTable) return state.signatureProfiles;
	return [];
}

function insertRows(table: unknown, rows: unknown[]) {
	if (table === state.finalDocumentsTable) {
		const inserted = (rows as Array<Record<string, unknown>>).map((row) => ({
			id: "90000000-0000-4000-8000-000000000001",
			createdAt: new Date("2026-05-20T08:00:00.000Z"),
			...row,
		}));
		state.finalDocuments.push(...inserted);
		return inserted;
	}
	if (table === state.fieldValuesTable) {
		state.fieldValues.push(...rows);
		return rows;
	}
	if (table === state.auditEventsTable) {
		state.auditEvents.push(...rows);
		return rows;
	}
	if (table === state.emailSendRecordsTable) {
		state.emailSends.push(...(rows as Array<Record<string, unknown>>));
		return rows;
	}
	if (table === state.signatureProfilesTable) {
		const inserted = (rows as Array<Record<string, unknown>>).map((row, index) => ({
			id: `60000000-0000-4000-8000-${String(state.signatureProfiles.length + index + 1).padStart(12, "0")}`,
			createdAt: new Date("2026-05-20T08:00:00.000Z"),
			...row,
		}));
		state.signatureProfiles.push(...inserted);
		return inserted;
	}
	return [];
}

type UpdateValue = { status?: string; page?: number; x?: number; y?: number };

function updateRows(table: unknown, value: UpdateValue, condition: unknown) {
	if (table === state.recipientsTable) {
		const recipientId = conditionValues(condition).find((value) =>
			state.recipients.some((recipient) => recipient.id === value),
		);
		state.recipients = state.recipients.map((recipient) =>
			recipient.id === recipientId ? { ...recipient, status: value.status ?? "sent" } : recipient,
		);
	}
	if (table === state.envelopesTable) {
		state.envelopes[0] = { ...state.envelopes[0], status: value.status ?? "sent" };
	}
	if (table === state.fieldsTable) {
		state.fields[0] = { ...state.fields[0], ...value };
	}
}

function conditionValues(condition: unknown): unknown[] {
	if (!condition || typeof condition !== "object") return [];
	if ("value" in condition) return [condition.value];
	if (!("queryChunks" in condition) || !Array.isArray(condition.queryChunks)) return [];
	return condition.queryChunks.flatMap(conditionValues);
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
						values: (rows: unknown[] | unknown) => ({
							returning: async () => insertRows(table, Array.isArray(rows) ? rows : [rows]),
						}),
					}),
					update: (table: unknown) => ({
						set: (value: UpdateValue) => ({
							where: async (condition: unknown) => {
								updateRows(table, value, condition);
								return [];
							},
						}),
					}),
				},
				(table) => selectRows(table) as Array<Record<string, unknown>>,
			),
	};
});

describe("signing flow API", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.fieldsTable = envelopeFields;
		state.tokensTable = signerTokens;
		state.sourceDocumentsTable = sourceDocuments;
		state.fieldValuesTable = fieldValues;
		state.finalDocumentsTable = finalDocuments;
		state.auditEventsTable = auditEvents;
		state.emailSendRecordsTable = emailSendRecords;
		state.signatureProfilesTable = signatureProfiles;
		state.envelopes[0] = {
			id: "00000000-0000-4000-8000-000000000001",
			status: "sent",
			signingMode: "me_and_another_signer",
			createdBy: "user_123",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
			sentBy: "sender_123",
			sentAt: new Date("2026-05-20T07:04:00.000Z"),
		};
		state.recipients = [
			{
				id: "20000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "sent",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
			{
				id: "20000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Grace Hopper",
				email: "grace@example.com",
				status: "sent",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
		];
		state.fields = [
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
		];
		state.tokens = [
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
		];
		state.fieldValues.length = 0;
		state.finalDocuments.length = 0;
		state.auditEvents.length = 0;
		state.emailSends.length = 0;
		state.signatureProfiles.length = 0;
	});

	it("opens a valid magic link without internal login and returns only assigned fields", async () => {
		state.fields.push({
			id: "50000000-0000-4000-8000-000000000003",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000002",
			type: "signature",
			page: 1,
			x: 72,
			y: 224,
			width: 180,
			height: 48,
			createdAt: new Date("2026-05-20T07:06:00.000Z"),
		});
		state.fieldValues.push({
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000002",
			fieldId: "50000000-0000-4000-8000-000000000003",
			value: "Grace Hopper",
			completedAt: new Date("2026-05-20T07:07:00.000Z"),
		});

		const response = await apiHono.request("/api/signing/valid-token", {
			headers: { "x-now": "2026-05-20T07:03:00.000Z" },
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				signingMode: "me_and_another_signer",
				sourceDocument: {
					version: 1,
					contentType: "application/pdf",
					downloadUrl: "/api/signing/valid-token/source-pdf",
				},
				fields: [
					expect.objectContaining({
						id: "50000000-0000-4000-8000-000000000001",
						type: "signature",
						page: 1,
					}),
					expect.objectContaining({
						id: "50000000-0000-4000-8000-000000000002",
						type: "date",
						page: 1,
					}),
				],
				previewFields: expect.arrayContaining([
					expect.objectContaining({
						id: "50000000-0000-4000-8000-000000000001",
						recipientName: "Ada Lovelace",
						value: null,
						assignedToCurrentSigner: true,
					}),
					expect.objectContaining({
						id: "50000000-0000-4000-8000-000000000003",
						recipientName: "Grace Hopper",
						value: "Grace Hopper",
						assignedToCurrentSigner: false,
					}),
				]),
				signaturePreference: null,
			},
		});
	});

	it("lets self-signers reposition their assigned fields before completion", async () => {
		// Assumptions before RED:
		// - Repositioning is token-scoped, not a draft envelope edit.
		// - Only the self-sign signer can move their own assigned signature/date fields.
		// - The update persists canonical 612x792 PDF coordinates used by finalization.
		state.envelopes[0] = {
			...state.envelopes[0],
			signingMode: "only_me",
		};

		const response = await apiHono.request(
			"/api/signing/valid-token/fields/50000000-0000-4000-8000-000000000001",
			{
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					"x-now": "2026-05-20T08:00:00.000Z",
				},
				body: JSON.stringify({ page: 1, x: 96, y: 192 }),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: expect.objectContaining({
				id: "50000000-0000-4000-8000-000000000001",
				type: "signature",
				page: 1,
				x: 96,
				y: 192,
			}),
		});
		expect(state.fields[0]).toEqual(expect.objectContaining({ page: 1, x: 96, y: 192 }));
	});

	it("loads an existing saved partner signature as the default for the same email", async () => {
		state.signatureProfiles.push(
			{
				id: "60000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000099",
				createdBy: "ADA@example.com",
				kind: "drawn",
				label: "Older drawn",
				svgPath: "M 1 1 L 2 2",
				typedText: null,
				typedFont: null,
				selected: true,
				createdAt: new Date("2026-05-19T09:00:00.000Z"),
			},
			{
				id: "60000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000098",
				createdBy: "ada@example.com",
				kind: "typed",
				label: "Ada reusable typed",
				svgPath: null,
				typedText: "Ada Reused",
				typedFont: "serif",
				selected: true,
				createdAt: new Date("2026-05-21T09:00:00.000Z"),
			},
		);

		const response = await apiHono.request("/api/signing/valid-token", {
			headers: { "x-now": "2026-05-20T07:03:00.000Z" },
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: expect.objectContaining({
				recipientId: "20000000-0000-4000-8000-000000000001",
				signaturePreference: expect.objectContaining({
					id: "60000000-0000-4000-8000-000000000002",
					createdBy: "ada@example.com",
					kind: "typed",
					label: "Ada reusable typed",
					typedText: "Ada Reused",
					typedFont: "serif",
				}),
			}),
		});
	});

	it("downloads the current source PDF for a verified partner", async () => {
		const response = await apiHono.request(
			"/api/signing/valid-token/source-pdf",
			{
				headers: { "x-now": "2026-05-20T07:03:00.000Z" },
			},
			{
				DOCUMENTS_BUCKET: {
					get: async (key: string) => ({
						arrayBuffer: async () => pdfFixtureBytes(key).buffer,
					}),
				},
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(new TextDecoder().decode(await response.arrayBuffer())).toContain("source-v1.pdf");
	});

	it("completes typed signature and date fields while other recipients remain outstanding", async () => {
		const response = await apiHono.request("/api/signing/valid-token/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-21T23:45:00.000Z",
			},
			body: JSON.stringify({
				signature: {
					kind: "typed",
					typedText: "Ada Lovelace",
					typedFont: "cursive",
				},
				rememberSignature: false,
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				recipientStatus: "completed",
				envelopeStatus: "sent",
			},
		});
		expect(state.fieldValues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					fieldId: "50000000-0000-4000-8000-000000000001",
					value: "Ada Lovelace",
				}),
				expect.objectContaining({
					fieldId: "50000000-0000-4000-8000-000000000002",
					value: "2026-05-21",
				}),
			]),
		);
		expect(state.recipients[0]?.status).toBe("completed");
		expect(state.envelopes[0]?.status).toBe("sent");
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "recipient.completed" }),
				expect.objectContaining({ eventType: "field.value.completed" }),
			]),
		);
		expect(state.signatureProfiles).toHaveLength(0);
	});

	it("delivers a sender notification email when a partner signs while others remain pending", async () => {
		// Assumptions for the partner-signed notification regression:
		// - Partner signing is observable even before every signer has completed.
		// - The initiator email is the envelope createdBy email in the no-account flow.
		// - The notification is both persisted as an email_send_records row and delivered through Resend when configured.
		// - The notification links to the sender's existing envelope status surface; completed-document routing is out of scope here.
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "resend-email-1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		state.envelopes[0] = {
			...state.envelopes[0],
			createdBy: "sender@example.com",
			sentBy: "sender@example.com",
		};

		const response = await apiHono.request(
			"/api/signing/valid-token/complete",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-now": "2026-05-21T23:45:00.000Z",
				},
				body: JSON.stringify({
					signature: {
						kind: "typed",
						typedText: "Ada Lovelace",
						typedFont: "cursive",
					},
					rememberSignature: false,
				}),
			},
			{
				APP_BASE_URL: "https://signmos.example",
				RESEND_API_KEY: "re_test",
				RESEND_FROM_EMAIL: "Signmos <sign@signmos.example>",
				RESEND_REPLY_TO_EMAIL: "support@signmos.example",
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				recipientStatus: "completed",
				envelopeStatus: "sent",
			},
		});
		expect(state.emailSends).toEqual([
			expect.objectContaining({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				tokenId: "30000000-0000-4000-8000-000000000001",
				email: "sender@example.com",
				kind: "partner_signed",
				fallbackUrl: "/envelope-fields?envelopeId=00000000-0000-4000-8000-000000000001",
			}),
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
		expect(requestBody).toEqual(
			expect.objectContaining({
				to: ["sender@example.com"],
				subject: "Dein Vertrag wurde unterzeichnet · amerged Sign",
			}),
		);
		expect(requestBody.html).toContain(
			"https://signmos.example/envelope-fields?envelopeId=00000000-0000-4000-8000-000000000001",
		);
		expect(requestBody.text).toContain("Ada Lovelace hat deinen Vertrag unterzeichnet");

		fetchMock.mockRestore();
	});

	it("allows the explicit manual-smoke email fallback only outside production", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "provider rejected test recipient" }), {
				status: 403,
			}),
		);
		state.envelopes[0] = {
			...state.envelopes[0],
			createdBy: "sender@example.com",
			sentBy: "sender@example.com",
		};

		const response = await apiHono.request(
			"/api/signing/valid-token/complete",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-email-delivery-test-bypass": "true",
					"x-now": "2026-05-21T23:45:00.000Z",
				},
				body: JSON.stringify({
					signature: {
						kind: "typed",
						typedText: "Ada Lovelace",
						typedFont: "cursive",
					},
					rememberSignature: false,
				}),
			},
			{
				APP_BASE_URL: "https://signmos.example",
				CLOUDFLARE_ENV: "development",
				RESEND_API_KEY: "re_test",
				RESEND_FROM_EMAIL: "Signmos <sign@signmos.example>",
				RESEND_REPLY_TO_EMAIL: "support@signmos.example",
			},
		);

		expect(response.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
		fetchMock.mockRestore();
	});

	it("completes signing with a drawn signature payload", async () => {
		const response = await apiHono.request("/api/signing/valid-token/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-20T08:00:00.000Z",
			},
			body: JSON.stringify({
				signature: {
					kind: "drawn",
					label: "Ada drawn",
					svgPath: "M 12 36 L 48 20 L 96 42",
				},
				rememberSignature: false,
			}),
		});

		expect(response.status).toBe(200);
		expect(state.fieldValues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					fieldId: "50000000-0000-4000-8000-000000000001",
					value: "M 12 36 L 48 20 L 96 42",
				}),
				expect.objectContaining({
					fieldId: "50000000-0000-4000-8000-000000000002",
					value: "2026-05-20",
				}),
			]),
		);
		expect(state.signatureProfiles).toHaveLength(0);
	});

	it("ignores future date payloads and stores the controlled signing date", async () => {
		const response = await apiHono.request("/api/signing/valid-token/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-20T08:00:00.000Z",
			},
			body: JSON.stringify({
				date: "2099-12-31",
				signature: {
					kind: "typed",
					typedText: "Ada Lovelace",
					typedFont: "cursive",
				},
				rememberSignature: false,
			}),
		});

		expect(response.status).toBe(200);
		expect(state.fieldValues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					fieldId: "50000000-0000-4000-8000-000000000002",
					value: "2026-05-20",
				}),
			]),
		);
	});

	it("remembers a typed partner signature only when explicit consent is selected", async () => {
		const response = await apiHono.request("/api/signing/valid-token/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-20T08:00:00.000Z",
			},
			body: JSON.stringify({
				date: "2026-05-20",
				signature: {
					kind: "typed",
					typedText: "Ada Remembered",
					typedFont: "serif",
				},
				rememberSignature: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(state.signatureProfiles).toEqual([
			expect.objectContaining({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				createdBy: "ada@example.com",
				kind: "typed",
				label: "Typed signature",
				svgPath: null,
				typedText: "Ada Remembered",
				typedFont: "serif",
				selected: true,
			}),
		]);
	});

	it("remembers a drawn partner signature with the reusable SVG path", async () => {
		const response = await apiHono.request("/api/signing/valid-token/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-20T08:00:00.000Z",
			},
			body: JSON.stringify({
				date: "2026-05-20",
				signature: {
					kind: "drawn",
					label: "Ada drawn",
					svgPath: "M 12 36 L 48 20 L 96 42",
				},
				rememberSignature: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(state.signatureProfiles).toEqual([
			expect.objectContaining({
				createdBy: "ada@example.com",
				kind: "drawn",
				label: "Ada drawn",
				svgPath: "M 12 36 L 48 20 L 96 42",
				typedText: null,
				typedFont: null,
				selected: true,
			}),
		]);
	});

	it("notifies the sender when the partner completes after sender-first signing", async () => {
		// Assumptions for issue #24:
		// - Sender-first send has already completed the sender recipient.
		// - The active signing token belongs to the partner.
		// - The sender notification is represented by an email_send_records row.
		state.envelopes[0] = {
			id: "00000000-0000-4000-8000-000000000001",
			status: "sent",
			signingMode: "me_and_another_signer",
			createdBy: "sender@example.com",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
			sentBy: "sender@example.com",
			sentAt: new Date("2026-05-20T07:04:00.000Z"),
		};
		state.recipients = [
			{
				id: "20000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Sender Person",
				email: "sender@example.com",
				status: "completed",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
			{
				id: "20000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Grace Hopper",
				email: "grace@example.com",
				status: "sent",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
		];
		state.fields = [
			{
				id: "50000000-0000-4000-8000-000000000003",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000002",
				type: "signature",
				page: 1,
				x: 72,
				y: 220,
				width: 180,
				height: 48,
				createdAt: new Date("2026-05-20T07:05:00.000Z"),
			},
		];
		state.tokens = [
			{
				id: "30000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000002",
				token: "valid-token",
				status: "active",
				expiresAt: new Date("2026-05-27T07:03:00.000Z"),
				verifiedAt: new Date("2026-05-20T07:04:00.000Z"),
				createdAt: new Date("2026-05-20T07:03:00.000Z"),
			},
		];

		const sourcePdf = pdfFixtureBytes("Sender-first agreement");
		state.sourceDocuments[0] = { ...state.sourceDocuments[0], byteSize: sourcePdf.byteLength };
		const storedPdfs = new Map<string, Uint8Array>([[state.sourceDocuments[0].r2Key, sourcePdf]]);
		const response = await apiHono.request(
			"/api/signing/valid-token/complete",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-now": "2026-05-20T08:00:00.000Z",
				},
				body: JSON.stringify({
					signatureName: "Grace Hopper",
					date: "2026-05-20",
				}),
			},
			{
				DOCUMENTS_BUCKET: {
					get: async (key: string) => {
						const bytes = storedPdfs.get(key);
						return bytes ? { arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
					},
					put: async (key: string, bytes: Uint8Array) => {
						storedPdfs.set(key, bytes);
						return null;
					},
				},
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000002",
				recipientStatus: "completed",
				envelopeStatus: "completed",
			},
		});
		expect(state.emailSends).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					envelopeId: "00000000-0000-4000-8000-000000000001",
					recipientId: "20000000-0000-4000-8000-000000000002",
					tokenId: "30000000-0000-4000-8000-000000000002",
					email: "sender@example.com",
					kind: "partner_signed",
					fallbackUrl: "/envelope-fields?envelopeId=00000000-0000-4000-8000-000000000001",
				}),
				expect.objectContaining({
					recipientId: "20000000-0000-4000-8000-000000000002",
					email: "grace@example.com",
					kind: "completion",
				}),
			]),
		);
		expect(state.finalDocuments).toHaveLength(1);
		const finalKey = state.finalDocuments[0]?.r2Key;
		expect(typeof finalKey).toBe("string");
		const finalPdf = storedPdfs.get(String(finalKey));
		expect(finalPdf).toBeDefined();
		expect((await PDFDocument.load(finalPdf as Uint8Array)).getPageCount()).toBe(2);
	});

	it("rejects completion when the signer has no assigned fields", async () => {
		state.fields = [];

		const response = await apiHono.request("/api/signing/valid-token/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-20T08:00:00.000Z",
			},
			body: JSON.stringify({
				signatureName: "Ada Lovelace",
				date: "2026-05-20",
			}),
		});

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "NO_ASSIGNED_FIELDS",
				message: "No signing fields are assigned to this recipient",
				allowedActions: ["request_changes"],
			},
		});
		expect(state.fieldValues).toHaveLength(0);
		expect(state.recipients[0]?.status).toBe("sent");
		expect(state.envelopes[0]?.status).toBe("sent");
	});

	it("declines with a reason and optional comment while appending audit events", async () => {
		const response = await apiHono.request("/api/signing/valid-token/decline", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-now": "2026-05-20T08:00:00.000Z",
			},
			body: JSON.stringify({
				reason: "Terms need legal review",
				comment: "Please send an updated version.",
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				recipientStatus: "declined",
				envelopeStatus: "declined",
			},
		});
		expect(state.recipients[0]?.status).toBe("declined");
		expect(state.envelopes[0]?.status).toBe("declined");
		expect(state.auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "recipient.declined",
					message: "Terms need legal review",
				}),
				expect.objectContaining({
					eventType: "recipient.comment",
					message: "Please send an updated version.",
				}),
			]),
		);
	});
});
