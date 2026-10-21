import { agenticApiTokens, agenticSecurityEvents } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { envelopeFields, fieldValues, signatureProfiles } from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureText } from "@/test/pdf-fixtures";
import { approveAgentReview } from "./agent-human-review-test-helper";
import {
	agentSelfSignBucket,
	agentSelfSignTables,
	selfSignRows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";

const ownerToken = "signmos_explicit_fields_owner";

vi.mock("@/db/setup", async () => {
	const { getAgentSelfSignTestDb } = await import("./agent-self-sign-test-db");
	return { getDb: getAgentSelfSignTestDb };
});

function headers(key: string, token = ownerToken, contentType = "application/json") {
	return {
		authorization: `Bearer ${token}`,
		"content-type": contentType,
		"idempotency-key": key,
		"x-now": state.now.toISOString(),
	};
}

async function addToken(id: string, email: string, token: string): Promise<void> {
	selfSignRows(agenticApiTokens).push({
		id,
		email,
		name: email,
		tokenHash: await hashAgenticCredential(token),
		tokenHint: "signmos_...test",
		status: "active",
		activeSlot: 1,
		lastUsedAt: null,
		revokedAt: null,
		createdAt: state.now,
	});
}

describe("agent self-sign lifecycle explicit field preparation", () => {
	beforeEach(async () => {
		state.rows = new Map(agentSelfSignTables.map((table) => [table, []]));
		state.r2Objects.clear();
		state.r2PutCounts.clear();
		state.now = new Date("2026-07-17T10:00:00.000Z");
		await addToken("a0000000-0000-4000-8000-000000000001", "ada@example.com", ownerToken);
	});

	it("enforces one signature placeholder, persists explicit geometry, and denies outsiders", async () => {
		const bucket = agentSelfSignBucket();
		const created = await apiHono.request("/api/v1/documents", {
			method: "POST",
			headers: headers("explicit-create"),
			body: JSON.stringify({ name: "Ada Lovelace" }),
		});
		const documentId = ((await created.json()) as { data: { documentId: string } }).data.documentId;
		const uploaded = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf`,
			{
				method: "PUT",
				headers: headers("explicit-upload", ownerToken, "application/pdf"),
				body: pdfFixtureText("explicit fields", 2),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(uploaded.status).toBe(201);
		const sourceMetadata = await apiHono.request(`/api/v1/documents/${documentId}/source-pdf`, {
			headers: headers("unused"),
		});
		expect(sourceMetadata.status).toBe(200);
		const sourceContent = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf/content`,
			{ headers: headers("unused") },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(sourceContent.status).toBe(200);
		expect(await sourceContent.text()).toBe(pdfFixtureText("explicit fields", 2));
		expect(selfSignRows(agenticSecurityEvents)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "agentic.source_pdf.metadata_read" }),
				expect.objectContaining({ eventType: "agentic.source_pdf.downloaded" }),
			]),
		);

		const duplicateSignature = await apiHono.request(`/api/v1/documents/${documentId}/fields`, {
			method: "POST",
			headers: headers("explicit-duplicate"),
			body: JSON.stringify({
				fields: [
					{ type: "signature", page: 2, x: 40, y: 60, width: 180, height: 48 },
					{ type: "signature", page: 2, x: 40, y: 140, width: 180, height: 48 },
				],
			}),
		});
		expect(duplicateSignature.status).toBe(409);
		await expect(duplicateSignature.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "SIGNATURE_PLACEHOLDER_LIMIT" }),
		});
		expect(selfSignRows(envelopeFields)).toHaveLength(0);

		const explicit = await apiHono.request(`/api/v1/documents/${documentId}/fields`, {
			method: "POST",
			headers: headers("explicit-valid"),
			body: JSON.stringify({
				fields: [
					{ type: "signature", page: 2, x: 40, y: 60, width: 180, height: 48 },
					{ type: "date", page: 2, x: 260, y: 60, width: 120, height: 32 },
				],
			}),
		});
		expect(explicit.status).toBe(201);
		expect(selfSignRows(envelopeFields)).toEqual([
			expect.objectContaining({ type: "signature", page: 2, x: 40, y: 60, width: 180, height: 48 }),
			expect.objectContaining({ type: "date", page: 2, x: 260, y: 60, width: 120, height: 32 }),
		]);
		const explicitReplay = await apiHono.request(`/api/v1/documents/${documentId}/fields`, {
			method: "POST",
			headers: headers("explicit-valid"),
			body: JSON.stringify({
				fields: [
					{ type: "signature", page: 2, x: 40, y: 60, width: 180, height: 48 },
					{ type: "date", page: 2, x: 260, y: 60, width: 120, height: 32 },
				],
			}),
		});
		expect(explicitReplay.status).toBe(201);
		expect(selfSignRows(envelopeFields)).toHaveLength(2);
		const draftOnly = await apiHono.request(`/api/v1/documents/${documentId}/fields`, {
			method: "POST",
			headers: headers("explicit-after-prepared"),
			body: JSON.stringify({
				fields: [{ type: "date", page: 2, x: 260, y: 120, width: 120, height: 32 }],
			}),
		});
		expect(draftOnly.status).toBe(409);
		await expect(draftOnly.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "AGENT_SELF_SIGN_ACTION_BLOCKED" }),
		});

		const outsiderToken = "signmos_explicit_fields_outsider";
		await addToken("a0000000-0000-4000-8000-000000000002", "outsider@example.com", outsiderToken);
		const outsiderTask = await apiHono.request(`/api/v1/documents/${documentId}/signing-task`, {
			headers: headers("unused", outsiderToken),
		});
		expect(outsiderTask.status).toBe(404);
		await expect(outsiderTask.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "AGENT_SIGNING_TASK_NOT_FOUND" }),
		});
		const outsiderSource = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf/content`,
			{ headers: headers("unused", outsiderToken) },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(outsiderSource.status).toBe(404);
	});

	it("completes a drawn signature and saves it only with explicit consent", async () => {
		const bucket = agentSelfSignBucket();
		const created = await apiHono.request("/api/v1/documents", {
			method: "POST",
			headers: headers("drawn-create"),
			body: JSON.stringify({ name: "Ada Lovelace" }),
		});
		const documentId = ((await created.json()) as { data: { documentId: string } }).data.documentId;
		await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf`,
			{
				method: "PUT",
				headers: headers("drawn-upload", ownerToken, "application/pdf"),
				body: pdfFixtureText("drawn completion"),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		await apiHono.request(`/api/v1/documents/${documentId}/fields/defaults`, {
			method: "POST",
			headers: headers("drawn-defaults"),
			body: JSON.stringify({ page: 1 }),
		});
		const completed = await approveAgentReview(
			await apiHono.request(
				`/api/v1/documents/${documentId}/complete`,
				{
					method: "POST",
					headers: headers("drawn-complete"),
					body: JSON.stringify({
						signature: {
							kind: "drawn",
							label: "Ada drawn",
							svgPath: "M 10 10 L 80 30 L 140 12",
						},
						rememberSignature: true,
						date: "2099-01-01",
					}),
				},
				{ DOCUMENTS_BUCKET: bucket },
			),
			{
				email: "ada@example.com",
				key: "drawn-complete-approval",
				env: { DOCUMENTS_BUCKET: bucket } as Env,
			},
		);
		expect(completed.status).toBe(200);
		expect(selfSignRows(fieldValues)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ value: "M 10 10 L 80 30 L 140 12" }),
				expect.objectContaining({ value: "2026-07-17" }),
			]),
		);
		expect(selfSignRows(signatureProfiles)).toEqual([
			expect.objectContaining({
				createdBy: "ada@example.com",
				kind: "drawn",
				svgPath: "M 10 10 L 80 30 L 140 12",
			}),
		]);
	});

	it("returns machine-recoverable precondition and validation errors", async () => {
		const created = await apiHono.request("/api/v1/documents", {
			method: "POST",
			headers: headers("recovery-create"),
			body: JSON.stringify({ name: "Ada Lovelace" }),
		});
		const documentId = ((await created.json()) as { data: { documentId: string } }).data.documentId;
		const missingSource = await apiHono.request(`/api/v1/documents/${documentId}/fields/defaults`, {
			method: "POST",
			headers: headers("recovery-fields"),
			body: JSON.stringify({ page: 1 }),
		});
		expect(missingSource.status).toBe(409);
		await expect(missingSource.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "AGENT_SELF_SIGN_ACTION_BLOCKED",
				retryable: false,
				allowedActions: expect.arrayContaining(["get_document_status"]),
				recoveryUrl: `/api/v1/documents/${documentId}/status`,
			}),
		});
		const invalidCompletion = await apiHono.request(`/api/v1/documents/${documentId}/complete`, {
			method: "POST",
			headers: headers("recovery-complete"),
			body: JSON.stringify({ signature: { kind: "typed", typedText: "" } }),
		});
		expect(invalidCompletion.status).toBe(400);
		await expect(invalidCompletion.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "INVALID_SIGNING_COMPLETION",
				validValues: ["typed", "drawn"],
				fields: ["signature"],
				recoveryUrl: "/agent.md",
			}),
		});
	});
});
