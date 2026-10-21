import { PDFDocument } from "pdf-lib";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	idempotencyRecords,
	signerTokens,
	sourceDocuments,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureText } from "@/test/pdf-fixtures";

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	idempotencyTable: null as unknown,
	sourceDocumentsTable: null as unknown,
	recipientsTable: null as unknown,
	fieldsTable: null as unknown,
	tokensTable: null as unknown,
	emailSendRecordsTable: null as unknown,
	fieldValuesTable: null as unknown,
	auditEventsTable: null as unknown,
	finalDocumentsTable: null as unknown,
	envelopes: [] as Array<Record<string, unknown>>,
	idempotencyRecords: [] as Array<Record<string, unknown>>,
	sourceDocuments: [] as Array<Record<string, unknown>>,
	recipients: [] as Array<Record<string, unknown>>,
	fields: [] as Array<Record<string, unknown>>,
	tokens: [] as Array<Record<string, unknown>>,
	emailSendRecords: [] as Array<Record<string, unknown>>,
	fieldValues: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	finalDocuments: [] as Array<Record<string, unknown>>,
	r2Objects: new Map<string, Uint8Array>(),
}));

function selectRows(table: unknown) {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.idempotencyTable) return state.idempotencyRecords;
	if (table === state.sourceDocumentsTable) return state.sourceDocuments;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.tokensTable) return state.tokens;
	if (table === state.emailSendRecordsTable) return state.emailSendRecords;
	if (table === state.fieldValuesTable) return state.fieldValues;
	if (table === state.auditEventsTable) return state.auditEvents;
	if (table === state.finalDocumentsTable) return state.finalDocuments;
	return [];
}

function insertRows(table: unknown, rows: Array<Record<string, unknown>>) {
	if (table === state.envelopesTable) return insertEnvelopes(rows);
	if (table === state.idempotencyTable) return pushRows(state.idempotencyRecords, rows);
	if (table === state.sourceDocumentsTable) return insertSourceDocuments(rows);
	if (table === state.recipientsTable) return insertRecipients(rows);
	if (table === state.fieldsTable) return insertFields(rows);
	if (table === state.tokensTable) return insertTokens(rows);
	if (table === state.emailSendRecordsTable) return pushRows(state.emailSendRecords, rows);
	if (table === state.fieldValuesTable) return pushRows(state.fieldValues, rows);
	if (table === state.auditEventsTable) return pushRows(state.auditEvents, rows);
	if (table === state.finalDocumentsTable) return insertFinalDocuments(rows);
	return rows;
}

function pushRows(target: Array<Record<string, unknown>>, rows: Array<Record<string, unknown>>) {
	target.push(...rows);
	return rows;
}

function insertEnvelopes(rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row, index) => ({
		id: `00000000-0000-4000-8000-${String(state.envelopes.length + index + 1).padStart(12, "0")}`,
		status: row.status ?? "draft",
		createdBy: row.createdBy,
		createdAt: new Date("2026-05-20T08:00:00.000Z"),
		sentBy: null,
		sentAt: null,
	}));
	state.envelopes.push(...inserted);
	return inserted;
}

function insertRecipients(rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row, index) => ({
		id: `20000000-0000-4000-8000-${String(state.recipients.length + index + 1).padStart(12, "0")}`,
		...row,
		createdAt: new Date("2026-05-20T08:01:00.000Z"),
	}));
	state.recipients.push(...inserted);
	return inserted;
}

function insertSourceDocuments(rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row, index) => ({
		id: `10000000-0000-4000-8000-${String(state.sourceDocuments.length + index + 1).padStart(12, "0")}`,
		...row,
		uploadedAt: new Date("2026-05-20T08:01:00.000Z"),
	}));
	state.sourceDocuments.push(...inserted);
	return inserted;
}

function insertFields(rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row, index) => ({
		id: `50000000-0000-4000-8000-${String(state.fields.length + index + 1).padStart(12, "0")}`,
		...row,
		createdAt: new Date("2026-05-20T08:02:00.000Z"),
	}));
	state.fields.push(...inserted);
	return inserted;
}

function insertTokens(rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row, index) => ({
		id: `30000000-0000-4000-8000-${String(state.tokens.length + index + 1).padStart(12, "0")}`,
		...row,
		createdAt: new Date("2026-05-20T08:03:00.000Z"),
	}));
	state.tokens.push(...inserted);
	return inserted;
}

function insertFinalDocuments(rows: Array<Record<string, unknown>>) {
	const inserted = rows.map((row, index) => ({
		id: `90000000-0000-4000-8000-${String(state.finalDocuments.length + index + 1).padStart(12, "0")}`,
		...row,
		createdAt: new Date("2026-05-20T09:00:00.000Z"),
	}));
	state.finalDocuments.push(...inserted);
	return inserted;
}

function deleteRows(table: unknown) {
	if (table === state.fieldsTable) state.fields.length = 0;
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
					delete: (table: unknown) => ({
						where: async () => deleteRows(table),
					}),
				},
				selectRows,
			),
	};
});

describe("agent lifecycle smoke path", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.idempotencyTable = idempotencyRecords;
		state.sourceDocumentsTable = sourceDocuments;
		state.recipientsTable = envelopeRecipients;
		state.fieldsTable = envelopeFields;
		state.tokensTable = signerTokens;
		state.emailSendRecordsTable = emailSendRecords;
		state.fieldValuesTable = fieldValues;
		state.auditEventsTable = auditEvents;
		state.finalDocumentsTable = finalDocuments;
		for (const key of [
			"envelopes",
			"idempotencyRecords",
			"sourceDocuments",
			"recipients",
			"fields",
			"tokens",
			"emailSendRecords",
			"fieldValues",
			"auditEvents",
			"finalDocuments",
		] as const) {
			state[key].length = 0;
		}
		state.r2Objects.clear();
	});

	it("creates, prepares, sends, polls, signs, and downloads a completed PDF", async () => {
		// Assumptions:
		// - The smoke path uses the public REST API only; DB and R2 are external boundaries.
		// - One recipient with one signature and one date field is enough to verify the v1 happy path.
		// - This test does not cover HITL visual review, certified signing, webhooks, or templates.
		const bucket = {
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

		const created = await apiHono.request("/api/envelopes", {
			method: "POST",
			headers: { "x-internal-user-id": "user_123" },
		});
		expect(created.status).toBe(201);
		const envelopeId = ((await created.json()) as { data: { id: string } }).data.id;

		const uploaded = await apiHono.request(
			`/api/envelopes/${envelopeId}/source-pdf`,
			{
				method: "POST",
				headers: {
					"content-type": "application/pdf",
					"x-internal-user-id": "user_123",
				},
				body: pdfFixtureText(),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(uploaded.status).toBe(201);

		const recipients = await apiHono.request(`/api/envelopes/${envelopeId}/recipients`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-internal-user-id": "user_123" },
			body: JSON.stringify({ recipients: [{ name: "Ada Lovelace", email: "ada@example.com" }] }),
		});
		expect(recipients.status).toBe(201);
		const recipientId = ((await recipients.json()) as { data: Array<{ id: string }> }).data[0]?.id;
		expect(recipientId).toBeTruthy();

		const fields = await apiHono.request(`/api/envelopes/${envelopeId}/fields`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-internal-user-id": "user_123" },
			body: JSON.stringify({
				fields: [
					{ recipientId, type: "signature", page: 1, x: 72, y: 144, width: 180, height: 48 },
					{ recipientId, type: "date", page: 1, x: 300, y: 144, width: 120, height: 32 },
				],
			}),
		});
		expect(fields.status).toBe(201);

		const sent = await apiHono.request(`/api/envelopes/${envelopeId}/actions`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-internal-user-id": "sender_123" },
			body: JSON.stringify({ action: "send" }),
		});
		expect(sent.status).toBe(200);
		const sentBody = (await sent.json()) as {
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
		const verificationToken = sentBody.data.verificationLinks[0]?.token;
		expect(sentBody.data.verificationLinks[0]).toEqual({
			recipientId,
			email: "ada@example.com",
			token: verificationToken,
			url: `/signing-verifications/${verificationToken}`,
			expiresAt: expect.any(String),
		});
		expect(verificationToken).toBeTruthy();

		const verified = await apiHono.request(`/api/signing/verifications/${verificationToken}`, {
			headers: { "x-now": "2026-05-20T08:30:00.000Z" },
		});
		expect(verified.status).toBe(200);
		const verifiedBody = (await verified.json()) as {
			data: { signingLink: { token: string; url: string } };
		};
		let token = verifiedBody.data.signingLink.token;
		expect(verifiedBody.data.signingLink.url).toBe(`/signing/${token}`);
		expect(token).toBeTruthy();

		const sentStatus = await apiHono.request(`/api/envelopes/${envelopeId}/status`);
		await expect(sentStatus.json()).resolves.toEqual({
			data: {
				envelopeId,
				status: "sent",
				finalPdfAvailable: false,
				allowedActions: ["view_signing_status", "resend_invitation", "cancel", "expire", "delete"],
				pendingRecipients: [
					{
						id: recipientId,
						name: "Ada Lovelace",
						email: "ada@example.com",
						status: "sent",
					},
				],
			},
		});

		const changeRequest = await apiHono.request(`/api/signing/${token}/change-request`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-now": "2026-05-20T08:45:00.000Z" },
			body: JSON.stringify({ comment: "Please update the billing address." }),
		});
		expect(changeRequest.status).toBe(200);

		const changesStatus = await apiHono.request(`/api/envelopes/${envelopeId}/status`);
		await expect(changesStatus.json()).resolves.toEqual({
			data: {
				envelopeId,
				status: "changes_requested",
				finalPdfAvailable: false,
				allowedActions: ["upload_revised_source_pdf", "cancel", "expire", "delete"],
				pendingRecipients: [],
				changeRequest: {
					comment: "Please update the billing address.",
				},
			},
		});

		const revisedUpload = await apiHono.request(
			`/api/envelopes/${envelopeId}/source-pdf`,
			{
				method: "POST",
				headers: {
					"content-type": "application/pdf",
					"x-internal-user-id": "sender_123",
				},
				body: pdfFixtureText("revised"),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(revisedUpload.status).toBe(201);
		expect(state.fields).toHaveLength(0);
		expect(state.envelopes[0]?.status).toBe("draft");

		const revisedFields = await apiHono.request(`/api/envelopes/${envelopeId}/fields`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-internal-user-id": "user_123" },
			body: JSON.stringify({
				fields: [
					{ recipientId, type: "signature", page: 1, x: 72, y: 144, width: 180, height: 48 },
					{ recipientId, type: "date", page: 1, x: 300, y: 144, width: 120, height: 32 },
				],
			}),
		});
		expect(revisedFields.status).toBe(201);

		const resent = await apiHono.request(`/api/envelopes/${envelopeId}/actions`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-internal-user-id": "sender_123" },
			body: JSON.stringify({ action: "send" }),
		});
		expect(resent.status).toBe(200);
		const resentBody = (await resent.json()) as {
			data: { verificationLinks: Array<{ token: string }> };
		};
		const revisedVerificationToken = resentBody.data.verificationLinks[0]?.token;
		expect(revisedVerificationToken).toBeTruthy();
		const revisedVerified = await apiHono.request(
			`/api/signing/verifications/${revisedVerificationToken}`,
			{ headers: { "x-now": "2026-05-20T08:55:00.000Z" } },
		);
		expect(revisedVerified.status).toBe(200);
		const revisedVerifiedBody = (await revisedVerified.json()) as {
			data: { signingLink: { token: string } };
		};
		token = revisedVerifiedBody.data.signingLink.token;

		const signed = await apiHono.request(
			`/api/signing/${token}/complete`,
			{
				method: "POST",
				headers: { "content-type": "application/json", "x-now": "2026-05-20T09:00:00.000Z" },
				body: JSON.stringify({ signatureName: "Ada Lovelace", date: "2026-05-20" }),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(signed.status).toBe(200);

		const completedStatus = await apiHono.request(`/api/envelopes/${envelopeId}/status`);
		await expect(completedStatus.json()).resolves.toEqual({
			data: {
				envelopeId,
				status: "completed",
				finalPdfAvailable: true,
				allowedActions: ["download_final_pdf", "delete"],
				pendingRecipients: [],
			},
		});

		const finalPdf = await apiHono.request(
			`/api/signing/${token}/final-pdf`,
			{ headers: { "x-now": "2026-05-20T09:01:00.000Z" } },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(finalPdf.status).toBe(200);
		expect(finalPdf.headers.get("content-type")).toBe("application/pdf");
		const parsedFinalPdf = await PDFDocument.load(await finalPdf.arrayBuffer());
		expect(parsedFinalPdf.getPageCount()).toBe(2);
	});
});
