import {
	auditEvents,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	senderVerificationTokens,
	signerTokens,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";

const currentEnvelopeId = "00000000-0000-4000-8000-000000000001";
const completedEnvelopeId = "00000000-0000-4000-8000-000000000002";
const sentEnvelopeId = "00000000-0000-4000-8000-000000000003";
const draftEnvelopeId = "00000000-0000-4000-8000-000000000004";
const oldEnvelopeId = "00000000-0000-4000-8000-000000000005";
const unrelatedEnvelopeId = "00000000-0000-4000-8000-000000000006";
const finalDocumentId = "90000000-0000-4000-8000-000000000001";
const finalR2Key = `envelopes/${completedEnvelopeId}/final.pdf`;

const state = vi.hoisted(() => ({
	envelopesTable: null as unknown,
	recipientsTable: null as unknown,
	senderVerificationTokensTable: null as unknown,
	signerTokensTable: null as unknown,
	finalDocumentsTable: null as unknown,
	fieldsTable: null as unknown,
	fieldValuesTable: null as unknown,
	auditEventsTable: null as unknown,
	envelopes: [] as Array<Record<string, unknown>>,
	recipients: [] as Array<Record<string, unknown>>,
	senderVerificationTokens: [] as Array<Record<string, unknown>>,
	signerTokens: [] as Array<Record<string, unknown>>,
	finalDocuments: [] as Array<Record<string, unknown>>,
	fields: [] as Array<Record<string, unknown>>,
	fieldValues: [] as Array<Record<string, unknown>>,
	auditEvents: [] as Array<Record<string, unknown>>,
	r2Objects: new Map<string, Uint8Array>(),
}));

function selectRows(table: unknown): Array<Record<string, unknown>> {
	if (table === state.envelopesTable) return state.envelopes;
	if (table === state.recipientsTable) return state.recipients;
	if (table === state.senderVerificationTokensTable) return state.senderVerificationTokens;
	if (table === state.signerTokensTable) return state.signerTokens;
	if (table === state.finalDocumentsTable) return state.finalDocuments;
	if (table === state.fieldsTable) return state.fields;
	if (table === state.fieldValuesTable) return state.fieldValues;
	if (table === state.auditEventsTable) return state.auditEvents;
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
							limit: async () => selectRows(table),
						}),
					}),
				},
				selectRows,
			),
	};
});

describe("confirmed email document history API", () => {
	beforeEach(() => {
		state.envelopesTable = envelopes;
		state.recipientsTable = envelopeRecipients;
		state.senderVerificationTokensTable = senderVerificationTokens;
		state.signerTokensTable = signerTokens;
		state.finalDocumentsTable = finalDocuments;
		state.fieldsTable = envelopeFields;
		state.fieldValuesTable = fieldValues;
		state.auditEventsTable = auditEvents;
		state.envelopes = [
			completedEnvelope(),
			{
				id: currentEnvelopeId,
				status: "draft",
				signingMode: "only_me",
				createdBy: "ADA@Example.COM",
				createdAt: new Date("2026-05-21T09:00:00.000Z"),
				sentBy: null,
				sentAt: null,
			},
			{
				id: sentEnvelopeId,
				status: "sent",
				signingMode: "only_me",
				createdBy: "ada@example.com",
				createdAt: new Date("2026-05-20T09:00:00.000Z"),
				sentBy: "ada@example.com",
				sentAt: new Date("2026-05-20T09:10:00.000Z"),
			},
			{
				id: draftEnvelopeId,
				status: "draft",
				signingMode: "me_and_another_signer",
				createdBy: "ada@example.com",
				createdAt: new Date("2026-05-19T09:00:00.000Z"),
				sentBy: null,
				sentAt: null,
			},
			{
				id: oldEnvelopeId,
				status: "completed",
				signingMode: "only_me",
				createdBy: "ada@example.com",
				createdAt: new Date("2026-04-20T08:59:59.000Z"),
				sentBy: "ada@example.com",
				sentAt: new Date("2026-04-20T09:01:00.000Z"),
			},
			{
				id: unrelatedEnvelopeId,
				status: "completed",
				signingMode: "only_me",
				createdBy: "grace@example.com",
				createdAt: new Date("2026-05-18T09:00:00.000Z"),
				sentBy: "grace@example.com",
				sentAt: new Date("2026-05-18T09:10:00.000Z"),
			},
		];
		state.senderVerificationTokens = [
			{
				id: "10000000-0000-4000-8000-000000000001",
				envelopeId: currentEnvelopeId,
				name: "Ada Lovelace",
				email: "Ada@Example.COM",
				token: "verified-sender-token",
				status: "verified",
				expiresAt: new Date("2026-05-21T09:30:00.000Z"),
				verifiedAt: new Date("2026-05-21T09:05:00.000Z"),
				createdAt: new Date("2026-05-21T09:00:00.000Z"),
			},
		];
		state.recipients = [
			recipient(
				completedEnvelopeId,
				"20000000-0000-4000-8000-000000000001",
				"Sender",
				"sender@example.com",
				"completed",
			),
			recipient(
				completedEnvelopeId,
				"20000000-0000-4000-8000-000000000002",
				"Ada Lovelace",
				"ADA@Example.COM",
				"completed",
			),
			recipient(
				sentEnvelopeId,
				"20000000-0000-4000-8000-000000000003",
				"Ada Lovelace",
				"ada@example.com",
				"sent",
			),
			recipient(
				draftEnvelopeId,
				"20000000-0000-4000-8000-000000000004",
				"Ada Lovelace",
				"ada@example.com",
				"pending",
			),
			recipient(
				draftEnvelopeId,
				"20000000-0000-4000-8000-000000000005",
				"Grace Hopper",
				"grace@example.com",
				"pending",
			),
			recipient(
				oldEnvelopeId,
				"20000000-0000-4000-8000-000000000006",
				"Ada Lovelace",
				"ada@example.com",
				"completed",
			),
			recipient(
				unrelatedEnvelopeId,
				"20000000-0000-4000-8000-000000000007",
				"Grace Hopper",
				"grace@example.com",
				"completed",
			),
		];
		state.signerTokens = [
			signerToken(
				completedEnvelopeId,
				"20000000-0000-4000-8000-000000000002",
				"completed-signer-token",
			),
			signerToken(sentEnvelopeId, "20000000-0000-4000-8000-000000000003", "sent-signer-token"),
		];
		const finalPdf = new TextEncoder().encode("%PDF-1.4\nhistory completed artifact\n%%EOF");
		state.finalDocuments = [
			{
				id: finalDocumentId,
				envelopeId: completedEnvelopeId,
				r2Key: finalR2Key,
				sha256: "b".repeat(64),
				byteSize: finalPdf.byteLength,
				contentType: "application/pdf",
				createdAt: new Date("2026-05-16T10:00:00.000Z"),
			},
		];
		state.fields = [];
		state.fieldValues = [];
		state.auditEvents = [];
		state.r2Objects.clear();
		state.r2Objects.set(finalR2Key, finalPdf);
	});

	it("rejects history before the current sender email session is confirmed", async () => {
		// #33 assumptions before RED:
		// - The current sender verification session is the access gate for email-linked history.
		// - Pending sender tokens do not prove email ownership, even when the token belongs to the envelope.
		state.senderVerificationTokens[0] = {
			...state.senderVerificationTokens[0],
			status: "pending",
			verifiedAt: null,
		};

		const response = await apiHono.request(`/api/envelopes/${currentEnvelopeId}/history`, {
			headers: {
				"x-sender-session-token": "verified-sender-token",
				"x-now": "2026-05-21T09:00:00.000Z",
			},
		});

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "HISTORY_FORBIDDEN",
				message: "Verified sender access is required before viewing document history",
			},
		});
	});

	it("returns normalized email history with status coverage, labels, and current actions", async () => {
		// #33 assumptions before RED:
		// - The normalized confirmed email is the history identity across creator and signer roles.
		// - The last-30-days window is inclusive at createdAt >= now - 30 days.
		// - Draft creator rows resume at upload, sent signer rows resume at signing, and completed
		//   rows reuse the completed-document bearer URL.
		const response = await apiHono.request(`/api/envelopes/${currentEnvelopeId}/history`, {
			headers: {
				"x-sender-session-token": "verified-sender-token",
				"x-now": "2026-05-21T09:00:00.000Z",
			},
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: {
				email: string;
				windowStart: string;
				documents: Array<{
					envelopeId: string;
					state: string;
					status: string;
					documentType: string;
					role: string;
					action: { type: string; url: string; downloadUrl?: string };
					creatorActions: Array<{ action: string; label: string }>;
				}>;
			};
		};
		expect(body.data.email).toBe("ada@example.com");
		expect(body.data.windowStart).toBe("2026-04-21T09:00:00.000Z");
		expect(body.data.documents.map((document) => document.envelopeId)).toEqual([
			currentEnvelopeId,
			sentEnvelopeId,
			draftEnvelopeId,
			completedEnvelopeId,
		]);
		expect(body.data.documents.map((document) => document.envelopeId)).not.toContain(oldEnvelopeId);
		expect(body.data.documents.map((document) => document.envelopeId)).not.toContain(
			unrelatedEnvelopeId,
		);
		expect(body.data.documents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					envelopeId: currentEnvelopeId,
					state: "draft",
					status: "draft",
					documentType: "self_signed",
					role: "creator",
					action: expect.objectContaining({
						type: "resume",
						url: `/source-pdf-upload?envelopeId=${currentEnvelopeId}&senderSessionToken=verified-sender-token`,
					}),
					creatorActions: [{ action: "delete", label: "Delete" }],
				}),
				expect.objectContaining({
					envelopeId: sentEnvelopeId,
					state: "in_progress",
					status: "sent",
					documentType: "self_signed",
					role: "creator_and_signer",
					action: expect.objectContaining({
						type: "resume",
						url: "/signing/sent-signer-token",
					}),
					creatorActions: [
						{ action: "cancel", label: "Cancel" },
						{ action: "delete", label: "Delete" },
					],
				}),
				expect.objectContaining({
					envelopeId: draftEnvelopeId,
					state: "draft",
					status: "draft",
					documentType: "signed_with_partner",
					role: "creator_and_signer",
					creatorActions: [{ action: "delete", label: "Delete" }],
				}),
				expect.objectContaining({
					envelopeId: completedEnvelopeId,
					state: "completed",
					status: "completed",
					documentType: "signed_with_partner",
					role: "signer",
					action: expect.objectContaining({
						type: "completed",
						url: "/completed-documents/completed-signer-token",
						downloadUrl: "/api/final-documents/completed-signer-token/pdf",
					}),
					creatorActions: [],
				}),
			]),
		);
	});

	it("lets completed history actions return the final PDF through existing access rules", async () => {
		const history = await apiHono.request(`/api/envelopes/${currentEnvelopeId}/history`, {
			headers: {
				"x-sender-session-token": "verified-sender-token",
				"x-now": "2026-05-21T09:00:00.000Z",
			},
		});
		const body = (await history.json()) as {
			data: {
				documents: Array<{
					envelopeId: string;
					action: { downloadUrl?: string };
				}>;
			};
		};
		const completed = body.data.documents.find(
			(document) => document.envelopeId === completedEnvelopeId,
		);

		const pdf = await apiHono.request(
			completed?.action.downloadUrl ?? "",
			{ headers: { "x-now": "2026-05-21T09:00:00.000Z" } },
			{
				DOCUMENTS_BUCKET: {
					get: async (key: string) => {
						const object = state.r2Objects.get(key);
						return object
							? {
									arrayBuffer: async () => object.buffer.slice(0),
								}
							: null;
					},
				},
			},
		);

		expect(pdf.status).toBe(200);
		expect(pdf.headers.get("content-type")).toBe("application/pdf");
		const bytes = new Uint8Array(await pdf.arrayBuffer());
		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
	});
});

function completedEnvelope(): Record<string, unknown> {
	return {
		id: completedEnvelopeId,
		status: "completed",
		signingMode: "me_and_another_signer",
		createdBy: "sender@example.com",
		createdAt: new Date("2026-05-16T09:00:00.000Z"),
		sentBy: "sender@example.com",
		sentAt: new Date("2026-05-16T09:10:00.000Z"),
	};
}

function recipient(
	envelopeId: string,
	id: string,
	name: string,
	email: string,
	status: string,
): Record<string, unknown> {
	return {
		id,
		envelopeId,
		name,
		email,
		status,
		createdAt: new Date("2026-05-16T09:05:00.000Z"),
	};
}

function signerToken(
	envelopeId: string,
	recipientId: string,
	token: string,
): Record<string, unknown> {
	return {
		id: `30000000-0000-4000-8000-${token === "sent-signer-token" ? "000000000002" : "000000000001"}`,
		envelopeId,
		recipientId,
		token,
		status: "active",
		expiresAt: new Date("2026-05-30T09:00:00.000Z"),
		verifiedAt: null,
		createdAt: new Date("2026-05-16T09:15:00.000Z"),
	};
}
