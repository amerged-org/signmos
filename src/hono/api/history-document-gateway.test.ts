import {
	auditEvents,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	signerTokens,
} from "@/db/envelope";
import { hashHistoryCredential, historySecurityEvents, historySessions } from "@/db/history-access";
import { apiHono } from "@/hono/api";

const envelopeId = "00000000-0000-4000-8000-000000000001";
const finalDocumentToken = "30000000-0000-4000-8000-000000000001";
const rawSession = "opaque-history-session-cookie";
const finalR2Key = `envelopes/${envelopeId}/final.pdf`;

const state = vi.hoisted(() => ({
	tables: new Map<string, unknown>(),
	envelopes: [] as Array<Record<string, unknown>>,
	recipients: [] as Array<Record<string, unknown>>,
	finalDocuments: [] as Array<Record<string, unknown>>,
	sessions: [] as Array<Record<string, unknown>>,
	securityEvents: [] as Array<Record<string, unknown>>,
	r2Objects: new Map<string, Uint8Array>(),
}));

function selectRows(table: unknown): Array<Record<string, unknown>> {
	if (table === state.tables.get("envelopes")) return state.envelopes;
	if (table === state.tables.get("recipients")) return state.recipients;
	if (table === state.tables.get("finalDocuments")) return state.finalDocuments;
	if (table === state.tables.get("sessions")) return state.sessions;
	return [];
}

function selectQuery(table: unknown) {
	const load = async () => selectRows(table);
	return Object.assign(load(), {
		where: () => ({ limit: load }),
		limit: load,
	});
}

vi.mock("@/db/setup", async () => {
	const { wrapSigningTestDb } = await import("@/db/envelope/signing-test-db");
	return {
		getDb: () =>
			wrapSigningTestDb(
				{
					select: () => ({
						from: (table: unknown) => selectQuery(table),
					}),
					update: (table: unknown) => ({
						set: (values: Record<string, unknown>) => ({
							where: () => ({
								returning: async () => {
									if (table !== state.tables.get("sessions")) return [];
									const session = state.sessions.find((candidate) => candidate.status === "active");
									if (!session) return [];
									Object.assign(session, values);
									return [session];
								},
							}),
						}),
					}),
					insert: (table: unknown) => ({
						values: (row: Record<string, unknown>) => ({
							returning: async () => {
								if (table !== state.tables.get("securityEvents")) return [];
								const inserted = { id: crypto.randomUUID(), ...row };
								state.securityEvents.push(inserted);
								return [inserted];
							},
						}),
					}),
				},
				selectRows,
			),
	};
});

describe("history completed-document gateway", () => {
	beforeEach(async () => {
		state.tables = new Map<string, unknown>([
			["envelopes", envelopes],
			["recipients", envelopeRecipients],
			["finalDocuments", finalDocuments],
			["sessions", historySessions],
			["securityEvents", historySecurityEvents],
			["fields", envelopeFields],
			["fieldValues", fieldValues],
			["auditEvents", auditEvents],
			["signerTokens", signerTokens],
		]);
		state.envelopes = [
			{
				id: envelopeId,
				status: "completed",
				signingMode: "only_me",
				createdBy: "owner@example.com",
				createdAt: new Date("2026-07-16T08:00:00.000Z"),
				sentBy: "owner@example.com",
				sentAt: new Date("2026-07-16T08:05:00.000Z"),
			},
		];
		state.recipients = [
			{
				id: "20000000-0000-4000-8000-000000000001",
				envelopeId,
				name: "Owner Example",
				email: "owner@example.com",
				status: "completed",
				createdAt: new Date("2026-07-16T08:01:00.000Z"),
			},
		];
		const finalPdf = new TextEncoder().encode("%PDF-1.4\nhistory artifact\n%%EOF");
		state.finalDocuments = [
			{
				id: finalDocumentToken,
				envelopeId,
				r2Key: finalR2Key,
				sha256: "a".repeat(64),
				byteSize: finalPdf.byteLength,
				contentType: "application/pdf",
				createdAt: new Date("2026-07-16T09:00:00.000Z"),
			},
		];
		state.sessions = [
			{
				id: "40000000-0000-4000-8000-000000000001",
				linkId: "10000000-0000-4000-8000-000000000001",
				email: "owner@example.com",
				sessionHash: await hashHistoryCredential(rawSession),
				status: "active",
				expiresAt: new Date("2026-07-17T16:29:59.000Z"),
				revokedAt: null,
				createdAt: new Date("2026-07-17T08:29:59.000Z"),
			},
		];
		state.securityEvents = [];
		state.r2Objects = new Map([[finalR2Key, finalPdf]]);
	});

	it("returns detail and PDF via the session without changing the bearer-link contract", async () => {
		// Issue #37 assumptions before RED:
		// - History detail mirrors completed-document data but replaces bearer download URLs.
		// - The envelope id is a non-secret locator authorized by the HTTP-only session.
		// - Existing final-document bearer routes remain independently valid.
		const headers = {
			cookie: `signmos_history_session=${rawSession}`,
			"x-now": "2026-07-17T16:29:58.000Z",
		};
		const detailResponse = await apiHono.request(`/api/history/documents/${envelopeId}`, {
			headers,
		});
		expect(detailResponse.status).toBe(200);
		const detail = await detailResponse.json();
		expect(detail).toEqual({
			data: expect.objectContaining({
				envelopeId,
				status: "completed",
				finalPdf: expect.objectContaining({
					downloadUrl: `/api/history/documents/${envelopeId}/pdf`,
				}),
			}),
		});
		expect(JSON.stringify(detail)).not.toContain(finalDocumentToken);

		const bucket = {
			get: async (key: string) => ({
				arrayBuffer: async () => state.r2Objects.get(key)?.buffer,
			}),
		};
		const pdfResponse = await apiHono.request(
			`/api/history/documents/${envelopeId}/pdf`,
			{ headers },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(pdfResponse.status).toBe(200);
		expect(pdfResponse.headers.get("content-type")).toBe("application/pdf");
		expect(new TextDecoder().decode(await pdfResponse.arrayBuffer())).toContain("history artifact");

		const existingBearerResponse = await apiHono.request(
			`/api/final-documents/${finalDocumentToken}`,
			{ headers: { "x-now": "2026-07-17T16:29:58.000Z" } },
		);
		expect(existingBearerResponse.status).toBe(200);
		const existingBearerBody = await existingBearerResponse.json();
		expect(existingBearerBody).toEqual({
			data: expect.objectContaining({ token: finalDocumentToken, envelopeId }),
		});
	});

	it("keeps the session expiry fixed and rejects it at and after eight hours", async () => {
		const cookie = `signmos_history_session=${rawSession}`;
		const originalExpiry = state.sessions[0]?.expiresAt;
		const beforeExpiry = await apiHono.request("/api/history/documents", {
			headers: { cookie, "x-now": "2026-07-17T16:29:58.999Z" },
		});
		expect(beforeExpiry.status).toBe(200);
		expect(state.sessions[0]?.expiresAt).toBe(originalExpiry);

		for (const now of ["2026-07-17T16:29:59.000Z", "2026-07-17T16:29:59.001Z"]) {
			const response = await apiHono.request("/api/history/documents", {
				headers: { cookie, "x-now": now },
			});
			expect(response.status).toBe(401);
			await expect(response.json()).resolves.toEqual({
				error: {
					code: "HISTORY_SESSION_EXPIRED",
					message: "Your My documents session expired",
					recoveryUrl: "/?task=my-documents",
				},
			});
		}
		expect(state.sessions[0]?.expiresAt).toBe(originalExpiry);
	});
});
