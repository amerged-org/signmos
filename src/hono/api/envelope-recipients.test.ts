import {
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	signatureProfiles,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	recipientsTable: null as unknown,
	fieldsTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	signerTokensTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	fieldValuesTable: null as unknown,
	signatureProfilesTable: null as unknown,
	envelopes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			status: "draft",
			createdBy: "user_123",
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
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "user_123",
			uploadedAt: new Date("2026-05-20T07:01:00.000Z"),
		},
	],
	recipients: [] as Array<{
		id: string;
		envelopeId: string;
		name: string;
		email: string;
		status: "pending" | "sent" | "completed";
		createdAt: Date;
	}>,
	fields: [] as Array<{
		id: string;
		envelopeId: string;
		recipientId: string;
		type: "signature" | "date";
		page: number;
		x: number;
		y: number;
		width: number;
		height: number;
		createdAt: Date;
	}>,
	tokens: [] as Array<{
		id: string;
		envelopeId: string;
		recipientId: string;
		token: string;
		status: "active";
		expiresAt: Date;
		createdAt: Date;
	}>,
	emailSends: [] as Array<{
		id: string;
		envelopeId: string;
		recipientId: string;
		tokenId: string;
		email: string;
		kind: string;
		fallbackUrl?: string;
		sentAt: Date;
	}>,
	fieldValues: [] as Array<Record<string, unknown>>,
	signatureProfiles: [] as Array<Record<string, unknown>>,
}));

function selectRows(table: unknown) {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.signerTokensTable) return state.tokens;
	if (table === state.emailSendRecordsTable) return state.emailSends;
	if (table === state.signatureProfilesTable) return state.signatureProfiles;
	return [];
}

function insertRows(table: unknown, rows: unknown[]) {
	if (table === state.recipientsTable) return insertRecipients(rows);
	if (table === state.signerTokensTable) return insertTokens(rows);
	if (table === state.emailSendRecordsTable) return insertEmailSends(rows);
	if (table === state.fieldValuesTable) {
		state.fieldValues.push(...(rows as Array<Record<string, unknown>>));
		return rows;
	}
	return [];
}

function insertRecipients(rows: unknown[]) {
	const inserted = rows.map((row, index) => {
		const recipient = row as { envelopeId: string; name: string; email: string; status: "pending" };
		return {
			id: `20000000-0000-4000-8000-${String(state.recipients.length + index + 1).padStart(12, "0")}`,
			envelopeId: recipient.envelopeId,
			name: recipient.name,
			email: recipient.email,
			status: recipient.status,
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
		};
	});
	state.recipients.push(...inserted);
	return inserted;
}

function insertTokens(rows: unknown[]) {
	const inserted = rows.map((row, index) => {
		const token = row as {
			envelopeId: string;
			recipientId: string;
			token: string;
			status: "active";
			expiresAt: Date;
		};
		return {
			id: `30000000-0000-4000-8000-${String(state.tokens.length + index + 1).padStart(12, "0")}`,
			envelopeId: token.envelopeId,
			recipientId: token.recipientId,
			token: token.token,
			status: token.status,
			expiresAt: token.expiresAt,
			createdAt: new Date("2026-05-20T07:03:00.000Z"),
		};
	});
	state.tokens.push(...inserted);
	return inserted;
}

function insertEmailSends(rows: unknown[]) {
	const inserted = rows.map((row, index) => {
		const send = row as {
			envelopeId: string;
			recipientId: string;
			tokenId: string;
			email: string;
			kind: "invitation" | "resend";
			fallbackUrl?: string;
		};
		return {
			id: `40000000-0000-4000-8000-${String(state.emailSends.length + index + 1).padStart(12, "0")}`,
			envelopeId: send.envelopeId,
			recipientId: send.recipientId,
			tokenId: send.tokenId,
			email: send.email,
			kind: send.kind,
			fallbackUrl: send.fallbackUrl,
			sentAt: new Date("2026-05-20T07:04:00.000Z"),
		};
	});
	state.emailSends.push(...inserted);
	return inserted;
}

interface UpdateValue {
	status?: "sent" | "completed";
	sentBy?: string;
	sentAt?: Date;
	name?: string;
	email?: string;
}

function updateRows(table: unknown, value: UpdateValue) {
	if (table === state.envelopesTable) updateEnvelope(value);
	if (table === state.recipientsTable) updateRecipients(value);
	return [];
}

function updateEnvelope(value: UpdateValue) {
	state.envelopes[0] = { ...state.envelopes[0], ...value };
}

function updateRecipients(value: UpdateValue) {
	updateRecipientIdentity(value);
	updateRecipientStatuses(value);
}

function updateRecipientIdentity(value: UpdateValue) {
	if (!value.name && !value.email) return;
	state.recipients = state.recipients.map((recipient) => ({
		...recipient,
		name: value.name ?? recipient.name,
		email: value.email ?? recipient.email,
	}));
}

function updateRecipientStatuses(value: UpdateValue) {
	if (!value.status) return;
	const status = value.status;
	const sentBy = state.envelopes[0]?.sentBy ?? state.recipients[0]?.email;
	state.recipients = state.recipients.map((recipient) =>
		applyRecipientStatusUpdate(recipient, status, sentBy),
	);
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
			values: (rows: unknown[] | unknown) => ({
				returning: async () => insertRows(table, Array.isArray(rows) ? rows : [rows]),
			}),
		}),
		update: (table: unknown) => ({
			set: (value: UpdateValue) => ({
				where: async () => updateRows(table, value),
			}),
		}),
		delete: (table: unknown) => ({
			where: async () => {
				if (table === state.fieldsTable) state.fields.length = 0;
				if (table === state.recipientsTable) state.recipients.length = 0;
				return [];
			},
		}),
	}),
}));

function applyRecipientStatusUpdate(
	recipient: (typeof state.recipients)[number],
	status: "sent" | "completed",
	sentBy: string | undefined,
): (typeof state.recipients)[number] {
	if (status === "completed" && recipient.email === sentBy) {
		return { ...recipient, status: "completed" };
	}
	if (status === "sent" && recipient.email !== sentBy) {
		return { ...recipient, status: "sent" };
	}
	return recipient;
}

describe("envelope recipient API", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.fieldsTable = envelopeFields;
		state.sourceDocumentsTable = sourceDocuments;
		state.signerTokensTable = signerTokens;
		state.emailSendRecordsTable = emailSendRecords;
		state.fieldValuesTable = fieldValues;
		state.signatureProfilesTable = signatureProfiles;
		state.recipients.length = 0;
		state.fields.length = 0;
		state.tokens.length = 0;
		state.emailSends.length = 0;
		state.fieldValues.length = 0;
		state.signatureProfiles.length = 0;
		state.envelopes[0] = {
			id: "00000000-0000-4000-8000-000000000001",
			status: "draft",
			createdBy: "user_123",
			createdAt: new Date("2026-05-20T07:00:00.000Z"),
			sentBy: null,
			sentAt: null,
		};
		state.sourceDocuments[0] = {
			id: "10000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source.pdf",
			sha256: "a".repeat(64),
			byteSize: 10,
			contentType: "application/pdf",
			uploadedBy: "user_123",
			uploadedAt: new Date("2026-05-20T07:01:00.000Z"),
		};
		state.sourceDocuments.length = 1;
		state.signatureProfiles.push({
			id: "60000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			createdBy: "ada@example.com",
			kind: "typed",
			label: "Ada typed",
			svgPath: null,
			typedText: "Ada Lovelace",
			typedFont: "cursive",
			selected: true,
			createdAt: new Date("2026-05-20T07:02:30.000Z"),
		});
		state.fields.push(
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
				createdAt: new Date("2026-05-20T07:03:00.000Z"),
			},
			{
				id: "50000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000002",
				type: "signature",
				page: 1,
				x: 72,
				y: 220,
				width: 180,
				height: 48,
				createdAt: new Date("2026-05-20T07:03:00.000Z"),
			},
		);
	});

	it("adds up to 10 recipients with valid names and emails", async () => {
		// Assumptions for issue #8 RED:
		// - Recipients are added in a batch through POST /api/envelopes/:id/recipients.
		// - The batch limit is 10 recipients per envelope.
		// - Send readiness is draft envelope + source PDF + at least one recipient.
		// - Signer tokens expire after 7 days; Resend is mocked at the external boundary.
		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/recipients",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "user_123",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					recipients: [
						{ name: "Ada Lovelace", email: "ada@example.com" },
						{ name: "Grace Hopper", email: "grace@example.com" },
					],
				}),
			},
		);

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({
			data: [
				{
					id: expect.any(String),
					envelopeId: "00000000-0000-4000-8000-000000000001",
					name: "Ada Lovelace",
					email: "ada@example.com",
					status: "pending",
					createdAt: expect.any(String),
				},
				{
					id: expect.any(String),
					envelopeId: "00000000-0000-4000-8000-000000000001",
					name: "Grace Hopper",
					email: "grace@example.com",
					status: "pending",
					createdAt: expect.any(String),
				},
			],
		});
	});

	it("lists, edits, and deletes draft recipients for the verified sender", async () => {
		state.recipients.push({
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Grace Typo",
			email: "typo@example.com",
			status: "pending",
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
		});
		state.fields.push({
			id: "50000000-0000-4000-8000-000000000099",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			type: "signature",
			page: 1,
			x: 72,
			y: 144,
			width: 180,
			height: 48,
			createdAt: new Date("2026-05-20T07:03:00.000Z"),
		});

		const listed = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/recipients",
			{ headers: { "x-internal-user-id": "user_123" } },
		);
		expect(listed.status).toBe(200);
		await expect(listed.json()).resolves.toEqual({
			data: [
				expect.objectContaining({
					id: "20000000-0000-4000-8000-000000000001",
					name: "Grace Typo",
					email: "typo@example.com",
				}),
			],
		});

		const edited = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/recipients/20000000-0000-4000-8000-000000000001",
			{
				method: "PATCH",
				headers: {
					"x-internal-user-id": "user_123",
					"content-type": "application/json",
				},
				body: JSON.stringify({ name: "Grace Hopper", email: "grace@example.com" }),
			},
		);
		expect(edited.status).toBe(200);
		await expect(edited.json()).resolves.toEqual({
			data: expect.objectContaining({
				name: "Grace Hopper",
				email: "grace@example.com",
			}),
		});

		const deleted = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/recipients/20000000-0000-4000-8000-000000000001",
			{
				method: "DELETE",
				headers: { "x-internal-user-id": "user_123" },
			},
		);
		expect(deleted.status).toBe(200);
		expect(state.recipients).toHaveLength(0);
		expect(state.fields).toHaveLength(0);
	});

	it("rejects invalid emails and recipient batches above 10 with stable errors", async () => {
		const invalidEmail = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/recipients",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "user_123",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					recipients: [{ name: "Ada Lovelace", email: "not-an-email" }],
				}),
			},
		);

		expect(invalidEmail.status).toBe(400);
		await expect(invalidEmail.json()).resolves.toEqual({
			error: {
				code: "INVALID_RECIPIENTS",
				message: "Recipients must include 1 to 10 valid name and email entries",
				limit: 10,
			},
		});

		const tooMany = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/recipients",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "user_123",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					recipients: Array.from({ length: 11 }, (_, index) => ({
						name: `Signer ${index}`,
						email: `signer-${index}@example.com`,
					})),
				}),
			},
		);

		expect(tooMany.status).toBe(400);
		await expect(tooMany.json()).resolves.toEqual({
			error: {
				code: "INVALID_RECIPIENTS",
				message: "Recipients must include 1 to 10 valid name and email entries",
				limit: 10,
			},
		});
		expect(state.recipients).toHaveLength(0);
	});

	it("persists sender completion before sending only the partner invitation", async () => {
		// Assumptions for issue #24:
		// - The sender is represented as a recipient whose email matches the sender actor.
		// - Sending persists the sender's selected signature into assigned sender fields.
		// - Partner invitation records are created only after sender field values are persisted.
		// - The sender receives no self-sign token, signing link, or email send record.
		state.recipients.push(
			{
				id: "20000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "pending",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
			{
				id: "20000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Grace Hopper",
				email: "grace@example.com",
				status: "pending",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
		);

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/actions",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "ada@example.com",
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
				sentBy: "ada@example.com",
				tokenCount: 1,
				emailSendCount: 1,
				verificationLinks: [
					{
						recipientId: "20000000-0000-4000-8000-000000000002",
						email: "grace@example.com",
						token: expect.any(String),
						url: expect.stringMatching(/^\/signing-verifications\//),
						expiresAt: expect.any(String),
					},
				],
			},
		});
		expect(state.envelopes[0]?.status).toBe("sent");
		expect(state.envelopes[0]?.sentBy).toBe("ada@example.com");
		expect(state.recipients).toEqual([
			expect.objectContaining({ email: "ada@example.com", status: "completed" }),
			expect.objectContaining({ email: "grace@example.com", status: "sent" }),
		]);
		expect(state.fieldValues).toEqual([
			expect.objectContaining({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				recipientId: "20000000-0000-4000-8000-000000000001",
				fieldId: "50000000-0000-4000-8000-000000000001",
				value: "Ada Lovelace",
			}),
		]);
		expect(state.tokens).toHaveLength(1);
		expect(state.tokens[0]).toEqual(
			expect.objectContaining({ recipientId: "20000000-0000-4000-8000-000000000002" }),
		);
		expect(state.emailSends).toEqual([
			expect.objectContaining({
				email: "grace@example.com",
				kind: "partner_verification",
				fallbackUrl: expect.stringMatching(/^\/signing-verifications\//),
			}),
		]);

		const statusResponse = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/status",
		);
		expect(statusResponse.status).toBe(200);
		await expect(statusResponse.json()).resolves.toEqual({
			data: {
				envelopeId: "00000000-0000-4000-8000-000000000001",
				status: "sent",
				finalPdfAvailable: false,
				allowedActions: ["view_signing_status", "resend_invitation", "cancel", "expire", "delete"],
				pendingRecipients: [
					{
						id: "20000000-0000-4000-8000-000000000002",
						name: "Grace Hopper",
						email: "grace@example.com",
						status: "sent",
					},
				],
			},
		});
	});

	it("returns a stable send error when the envelope has no persisted source PDF", async () => {
		state.sourceDocuments.length = 0;
		state.recipients.push(
			{
				id: "20000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "pending",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
			{
				id: "20000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Grace Hopper",
				email: "grace@example.com",
				status: "pending",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
		);

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/actions",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "ada@example.com",
					"content-type": "application/json",
				},
				body: JSON.stringify({ action: "send" }),
			},
		);

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "SOURCE_PDF_REQUIRED",
				message: "Upload a source PDF before sending this envelope",
				allowedActions: ["upload_source_pdf"],
			},
		});
		expect(state.envelopes[0]?.status).toBe("draft");
		expect(state.tokens).toHaveLength(0);
		expect(state.emailSends).toHaveLength(0);
	});

	it("returns a stable send error when a recipient has no assigned fields", async () => {
		state.fields = state.fields.filter(
			(field) => field.recipientId === "20000000-0000-4000-8000-000000000001",
		);
		state.recipients.push(
			{
				id: "20000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "pending",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
			{
				id: "20000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Grace Hopper",
				email: "grace@example.com",
				status: "pending",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
		);

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/actions",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "ada@example.com",
					"content-type": "application/json",
				},
				body: JSON.stringify({ action: "send" }),
			},
		);

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "RECIPIENT_FIELDS_REQUIRED",
				message: "Place at least one field for every recipient before sending this envelope",
				allowedActions: ["add_fields"],
			},
		});
		expect(state.envelopes[0]?.status).toBe("draft");
		expect(state.tokens).toHaveLength(0);
		expect(state.emailSends).toHaveLength(0);
	});

	it("delivers only the partner invitation through Resend when the sender already signed", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "resend-email" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		state.recipients.push(
			{
				id: "20000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Ada Lovelace",
				email: "ada@example.com",
				status: "pending",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
			{
				id: "20000000-0000-4000-8000-000000000002",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				name: "Grace Hopper",
				email: "grace@example.com",
				status: "pending",
				createdAt: new Date("2026-05-20T07:02:00.000Z"),
			},
		);

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/actions",
			{
				method: "POST",
				headers: {
					"x-internal-user-id": "ada@example.com",
					"content-type": "application/json",
				},
				body: JSON.stringify({ action: "send" }),
			},
			{
				APP_BASE_URL: "https://signmos.example",
				RESEND_API_KEY: "re_test",
				RESEND_FROM_EMAIL: "Signmos <sign@signmos.example>",
				RESEND_REPLY_TO_EMAIL: "support@signmos.example",
			},
		);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
		expect(body).toEqual(
			expect.objectContaining({
				to: ["grace@example.com"],
				subject: "Deine Unterschrift wird benötigt · amerged Sign",
				html: expect.stringContaining("https://signmos.example/signing-verifications/"),
			}),
		);
		expect(body.html).not.toContain("/api/");
		expect(body.html).not.toContain("https://signmos.example/signing/");

		fetchMock.mockRestore();
	});

	it("delivers partner verification emails through Resend when configured", async () => {
		// Assumptions for Resend delivery RED:
		// - POST /api/envelopes/:id/actions remains the public send boundary.
		// - A complete Resend config is api key + from email + reply-to email.
		// - Missing Resend config keeps local fallback records without calling the network.
		// - This slice covers partner verification delivery, not reminder schedules or webhooks.
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "resend-email-1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		state.recipients.push({
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "pending",
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
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
				headers: {
					authorization: "Bearer re_test",
					"content-type": "application/json",
				},
				body: expect.any(String),
			}),
		);
		const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
		expect(requestBody).toEqual(
			expect.objectContaining({
				from: "Signmos <sign@signmos.example>",
				reply_to: "support@signmos.example",
				to: ["ada@example.com"],
				subject: "Deine Unterschrift wird benötigt · amerged Sign",
			}),
		);
		expect(requestBody.html).toContain("https://signmos.example/signing-verifications/");
		expect(state.emailSends).toEqual([
			expect.objectContaining({
				email: "ada@example.com",
				kind: "partner_verification",
				fallbackUrl: expect.stringMatching(/^\/signing-verifications\//),
			}),
		]);

		fetchMock.mockRestore();
	});

	it("does not mark the envelope sent when configured Resend delivery fails", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("domain not verified", { status: 422 }));
		state.recipients.push({
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "pending",
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
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
			{
				APP_BASE_URL: "https://signmos.example",
				RESEND_API_KEY: "re_test",
				RESEND_FROM_EMAIL: "Signmos <sign@signmos.example>",
				RESEND_REPLY_TO_EMAIL: "support@signmos.example",
			},
		);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "EMAIL_DELIVERY_FAILED",
				message: "Email provider rejected the message",
				providerStatus: 422,
				providerMessage: "domain not verified",
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(state.envelopes[0]?.status).toBe("draft");
		expect(state.emailSends).toHaveLength(0);

		fetchMock.mockRestore();
	});

	it("manually resends an invitation without duplicating recipients", async () => {
		state.recipients.push({
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "sent",
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
		});
		state.tokens.push({
			id: "30000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			token: "token-1",
			status: "active",
			expiresAt: new Date("2026-05-27T07:03:00.000Z"),
			createdAt: new Date("2026-05-20T07:03:00.000Z"),
		});
		state.emailSends.push({
			id: "40000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			tokenId: "30000000-0000-4000-8000-000000000001",
			email: "ada@example.com",
			kind: "invitation",
			sentAt: new Date("2026-05-20T07:04:00.000Z"),
		});

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/recipients/20000000-0000-4000-8000-000000000001/resend",
			{
				method: "POST",
				headers: { "x-internal-user-id": "sender_123" },
			},
		);

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({
			data: {
				recipientId: "20000000-0000-4000-8000-000000000001",
				email: "ada@example.com",
				emailSendCount: 2,
			},
		});
		expect(state.recipients).toHaveLength(1);
		expect(state.tokens).toHaveLength(2);
		expect(state.emailSends).toHaveLength(2);
		expect(state.emailSends[1]).toEqual(
			expect.objectContaining({
				kind: "resend",
				fallbackUrl: `/signing-verifications/${state.tokens[1]?.token}`,
			}),
		);
	});

	it("delivers manual resend invitations through Resend when configured", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "resend-email-2" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		state.recipients.push({
			id: "20000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			name: "Ada Lovelace",
			email: "ada@example.com",
			status: "sent",
			createdAt: new Date("2026-05-20T07:02:00.000Z"),
		});

		const response = await apiHono.request(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/recipients/20000000-0000-4000-8000-000000000001/resend",
			{
				method: "POST",
				headers: { "x-internal-user-id": "sender_123" },
			},
			{
				APP_BASE_URL: "https://signmos.example",
				RESEND_API_KEY: "re_test",
				RESEND_FROM_EMAIL: "Signmos <sign@signmos.example>",
				RESEND_REPLY_TO_EMAIL: "support@signmos.example",
			},
		);

		expect(response.status).toBe(201);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
		expect(requestBody).toEqual(
			expect.objectContaining({
				to: ["ada@example.com"],
				subject: "Deine Unterschrift wird benötigt · amerged Sign",
			}),
		);
		expect(requestBody.html).toContain("https://signmos.example/signing-verifications/");
		expect(state.emailSends).toEqual([
			expect.objectContaining({
				kind: "resend",
				email: "ada@example.com",
			}),
		]);

		fetchMock.mockRestore();
	});

	it("rejects expired signer tokens with a stable error", async () => {
		state.tokens.push({
			id: "30000000-0000-4000-8000-000000000001",
			envelopeId: "00000000-0000-4000-8000-000000000001",
			recipientId: "20000000-0000-4000-8000-000000000001",
			token: "expired-token",
			status: "active",
			expiresAt: new Date("2026-05-19T07:03:00.000Z"),
			createdAt: new Date("2026-05-12T07:03:00.000Z"),
		});

		const response = await apiHono.request("/api/signing/expired-token", {
			headers: { "x-now": "2026-05-20T07:03:00.000Z" },
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
