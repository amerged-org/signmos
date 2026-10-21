import { agenticApiTokens } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { auditEvents, envelopeRecipients, envelopes } from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureText } from "@/test/pdf-fixtures";
import {
	agentSelfSignTables,
	selfSignRows as rows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";

const rawToken = "signmos_self_sign_command_token";
const documentId = "00000000-0000-4000-8000-000000000001";
const fieldId = "50000000-0000-4000-8000-000000000001";

vi.mock("@/db/setup", async () => {
	const { getAgentSelfSignTestDb } = await import("./agent-self-sign-test-db");
	return { getDb: getAgentSelfSignTestDb };
});

describe("agent command idempotency", () => {
	beforeEach(async () => {
		state.rows = new Map(agentSelfSignTables.map((table) => [table, []]));
		rows(agenticApiTokens).push({
			id: "a0000000-0000-4000-8000-000000000001",
			email: "ada@example.com",
			name: "Ada command token",
			tokenHash: await hashAgenticCredential(rawToken),
			tokenHint: "signmos_...oken",
			status: "active",
			activeSlot: 1,
			lastUsedAt: null,
			revokedAt: null,
			createdAt: new Date("2026-07-17T08:00:00.000Z"),
		});
	});

	it("rejects a missing Idempotency-Key before every self-sign mutation", async () => {
		const mutations = [
			["POST", "/api/v1/documents", "application/json", JSON.stringify({ name: "Ada" })],
			["PUT", `/api/v1/documents/${documentId}/source-pdf`, "application/pdf", pdfFixtureText()],
			[
				"POST",
				`/api/v1/documents/${documentId}/signature-profiles`,
				"application/json",
				JSON.stringify({
					profile: {
						kind: "typed",
						label: "Ada",
						typedText: "Ada",
						typedFont: "cursive",
					},
					rememberSignature: true,
				}),
			],
			[
				"POST",
				`/api/v1/documents/${documentId}/fields`,
				"application/json",
				JSON.stringify({ fields: [] }),
			],
			[
				"POST",
				`/api/v1/documents/${documentId}/fields/defaults`,
				"application/json",
				JSON.stringify({ page: 1 }),
			],
			[
				"PATCH",
				`/api/v1/documents/${documentId}/fields/${fieldId}`,
				"application/json",
				JSON.stringify({ page: 1, x: 96, y: 192 }),
			],
			[
				"POST",
				`/api/v1/documents/${documentId}/complete`,
				"application/json",
				JSON.stringify({ signatureName: "Ada" }),
			],
			[
				"POST",
				`/api/v1/documents/${documentId}/recipients`,
				"application/json",
				JSON.stringify({ recipients: [{ name: "Partner", email: "partner@example.com" }] }),
			],
			[
				"PATCH",
				`/api/v1/documents/${documentId}/recipients/${fieldId}`,
				"application/json",
				JSON.stringify({ name: "Partner", email: "partner@example.com" }),
			],
			[
				"DELETE",
				`/api/v1/documents/${documentId}/recipients/${fieldId}`,
				"application/json",
				JSON.stringify({}),
			],
			["POST", `/api/v1/documents/${documentId}/send`, "application/json", JSON.stringify({})],
			[
				"POST",
				`/api/v1/documents/${documentId}/recipients/${fieldId}/resend`,
				"application/json",
				JSON.stringify({}),
			],
		] as const;

		for (const [method, path, contentType, body] of mutations) {
			const response = await apiHono.request(path, {
				method,
				headers: {
					authorization: `Bearer ${rawToken}`,
					"content-type": contentType,
					"x-now": "2026-07-17T10:00:00.000Z",
				},
				body,
			});
			expect(response.status, `${method} ${path}`).toBe(400);
			await expect(response.json()).resolves.toEqual({
				error: expect.objectContaining({
					code: "IDEMPOTENCY_KEY_REQUIRED",
					retryable: false,
				}),
			});
		}
	});

	it("replays the original create result and rejects a changed request without side effects", async () => {
		const request = (name: string) =>
			apiHono.request("/api/v1/documents", {
				method: "POST",
				headers: {
					authorization: `Bearer ${rawToken}`,
					"content-type": "application/json",
					"idempotency-key": "same-create-command",
					"x-now": "2026-07-17T10:00:00.000Z",
				},
				body: JSON.stringify({ name }),
			});
		const first = await request("Ada Lovelace");
		const firstBody = await first.json();
		const replay = await request("Ada Lovelace");
		expect(first.status).toBe(201);
		expect(replay.status).toBe(201);
		await expect(replay.json()).resolves.toEqual(firstBody);
		expect(rows(envelopes)).toHaveLength(1);
		expect(rows(envelopeRecipients)).toHaveLength(1);
		expect(rows(auditEvents)).toHaveLength(2);

		const conflict = await request("Changed signer");
		expect(conflict.status).toBe(409);
		await expect(conflict.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "IDEMPOTENCY_CONFLICT",
				retryable: false,
			}),
		});
		expect(rows(envelopes)).toHaveLength(1);
		expect(rows(envelopeRecipients)).toHaveLength(1);
		expect(rows(auditEvents)).toHaveLength(2);
	});
});
