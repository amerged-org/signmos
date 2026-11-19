import { agenticApiTokens, agenticSecurityEvents } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { apiHono } from "@/hono/api";
import {
	agentSelfSignTables,
	contractPdfFixture,
	selfSignRows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";

export const rawSelfSignToken = "signmos_agent_self_sign_token";
export const selfSignTokenId = "a0000000-0000-4000-8000-000000000001";

export function selfSignCommandHeaders(key: string, contentType = "application/json") {
	return {
		authorization: `Bearer ${rawSelfSignToken}`,
		"content-type": contentType,
		"idempotency-key": key,
		"x-now": state.now.toISOString(),
	};
}

export async function createUploadedSelfSignDraft(key: string, bucket: R2Bucket): Promise<string> {
	const created = await apiHono.request("/api/v1/documents", {
		method: "POST",
		headers: selfSignCommandHeaders(`${key}-create`),
		body: JSON.stringify({ name: "Ada Lovelace" }),
	});
	const documentId = ((await created.json()) as { data: { documentId: string } }).data.documentId;
	const uploaded = await apiHono.request(
		`/api/v1/documents/${documentId}/source-pdf`,
		{
			method: "PUT",
			headers: selfSignCommandHeaders(`${key}-upload`, "application/pdf"),
			body: await contractPdfFixture(),
		},
		{ DOCUMENTS_BUCKET: bucket },
	);
	expect(uploaded.status).toBe(201);
	return documentId;
}

export function selfSignSecurityEventsOfType(eventType: string) {
	return selfSignRows(agenticSecurityEvents).filter((event) => event.eventType === eventType);
}

export async function resetSelfSignTestFixture() {
	state.rows = new Map(agentSelfSignTables.map((table) => [table, []]));
	state.r2Objects.clear();
	state.r2PutCounts.clear();
	state.now = new Date("2026-07-17T10:00:00.000Z");
	selfSignRows(agenticApiTokens).push({
		id: selfSignTokenId,
		email: "ada@example.com",
		name: "Ada self-sign token",
		tokenHash: await hashAgenticCredential(rawSelfSignToken),
		tokenHint: "signmos_...oken",
		status: "active",
		activeSlot: 1,
		lastUsedAt: null,
		revokedAt: null,
		createdAt: new Date("2026-07-17T08:00:00.000Z"),
	});
}
