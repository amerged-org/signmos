import {
	agenticApiTokens,
	agenticCommandRecords,
	agenticSecurityEvents,
} from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import {
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	sourceDocuments,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureText } from "@/test/pdf-fixtures";
import {
	agentSelfSignBucket,
	selfSignRows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";

const rawToken = "signmos_agent_self_sign_token";
const tokenId = "a0000000-0000-4000-8000-000000000001";

function commandHeaders(key: string, contentType = "application/json") {
	return {
		authorization: `Bearer ${rawToken}`,
		"content-type": contentType,
		"idempotency-key": key,
		"x-now": state.now.toISOString(),
	};
}

async function createUploadedDraft(key: string, bucket: R2Bucket): Promise<string> {
	const created = await apiHono.request("/api/v1/documents", {
		method: "POST",
		headers: commandHeaders(`${key}-create`),
		body: JSON.stringify({ name: "Ada Lovelace" }),
	});
	const documentId = ((await created.json()) as { data: { documentId: string } }).data.documentId;
	const uploaded = await apiHono.request(
		`/api/v1/documents/${documentId}/source-pdf`,
		{
			method: "PUT",
			headers: commandHeaders(`${key}-upload`, "application/pdf"),
			body: pdfFixtureText("self sign workflow"),
		},
		{ DOCUMENTS_BUCKET: bucket },
	);
	expect(uploaded.status).toBe(201);
	return documentId;
}

export async function expectQueuedSelfSignReview() {
	const bucket = agentSelfSignBucket();
	const documentId = await createUploadedDraft("human-review-tracer", bucket);
	const prepared = await apiHono.request(`/api/v1/documents/${documentId}/fields/defaults`, {
		method: "POST",
		headers: commandHeaders("human-review-default-fields"),
		body: JSON.stringify({ page: 1 }),
	});
	expect(prepared.status).toBe(201);

	const response = await apiHono.request(
		`/api/v1/documents/${documentId}/complete`,
		{
			method: "POST",
			headers: commandHeaders("human-review-complete"),
			body: JSON.stringify({
				signature: { kind: "typed", typedText: "Ada Lovelace", typedFont: "cursive" },
				rememberSignature: false,
				date: "2099-12-31",
			}),
		},
		{ DOCUMENTS_BUCKET: bucket },
	);

	expect(response.status).toBe(202);
	await expect(response.json()).resolves.toEqual({
		data: {
			commandId: expect.any(String),
			status: "pending_human_review",
			reviewUrl: expect.stringMatching(/^http:\/\/localhost\/human-review\/[0-9a-f-]+$/),
			statusUrl: expect.stringMatching(/^http:\/\/localhost\/api\/v1\/commands\/[0-9a-f-]+$/),
			expiresAt: "2026-07-18T10:00:00.000Z",
			notificationStatus: expect.stringMatching(/^(sent|fallback|failed)$/),
		},
	});
	expect(selfSignRows(envelopes)[0]?.status).toBe("sent");
	expect(selfSignRows(fieldValues)).toHaveLength(0);
	expect(selfSignRows(finalDocuments)).toHaveLength(0);
	expect(
		selfSignRows(agenticSecurityEvents).filter(
			(event) => event.eventType === "agentic.self_sign.completed",
		),
	).toHaveLength(0);
}

export async function expectReplayAndExactTokenPolling() {
	const bucket = agentSelfSignBucket();
	const documentId = await createUploadedDraft("human-review-replay", bucket);
	const prepared = await apiHono.request(`/api/v1/documents/${documentId}/fields/defaults`, {
		method: "POST",
		headers: commandHeaders("human-review-replay-fields"),
		body: JSON.stringify({ page: 1 }),
	});
	expect(prepared.status).toBe(201);
	const payload = {
		signature: { kind: "typed", typedText: "Ada Lovelace", typedFont: "cursive" },
		rememberSignature: false,
	};
	const complete = (body: unknown) =>
		apiHono.request(`/api/v1/documents/${documentId}/complete`, {
			method: "POST",
			headers: commandHeaders("human-review-replay-command"),
			body: JSON.stringify(body),
		});

	const first = await complete(payload);
	expect(first.status).toBe(202);
	const firstBody = (await first.json()) as {
		data: { commandId: string; statusUrl: string };
	};
	const replay = await complete(payload);
	expect(replay.status).toBe(202);
	await expect(replay.json()).resolves.toEqual(firstBody);
	const conflict = await complete({
		...payload,
		signature: { ...payload.signature, typedText: "Changed signer" },
	});
	expect(conflict.status).toBe(409);
	await expect(conflict.json()).resolves.toEqual({
		error: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
	});

	const polled = await apiHono.request(new URL(firstBody.data.statusUrl).pathname, {
		headers: commandHeaders("unused-command-read"),
	});
	expect(polled.status).toBe(200);
	await expect(polled.json()).resolves.toEqual(firstBody);
	const otherRawToken = "signmos_same_email_other_personal_token";
	selfSignRows(agenticApiTokens).push({
		id: "a0000000-0000-4000-8000-000000000002",
		email: "ada@example.com",
		name: "Other Ada token",
		tokenHash: await hashAgenticCredential(otherRawToken),
		tokenHint: "signmos_...oken",
		status: "active",
		activeSlot: 2,
		lastUsedAt: null,
		revokedAt: null,
		createdAt: state.now,
	});
	const wrongTokenPoll = await apiHono.request(new URL(firstBody.data.statusUrl).pathname, {
		headers: {
			authorization: `Bearer ${otherRawToken}`,
			"x-now": state.now.toISOString(),
		},
	});
	expect(wrongTokenPoll.status).toBe(404);
	await expect(wrongTokenPoll.json()).resolves.toEqual({
		error: expect.objectContaining({ code: "AGENT_COMMAND_NOT_FOUND" }),
	});
	const command = selfSignRows(agenticCommandRecords).find(
		(row) => row.id === firstBody.data.commandId,
	);
	expect(command).toEqual(
		expect.objectContaining({
			tokenId,
			tokenName: "Ada self-sign token",
			idempotencyKey: "human-review-replay-command",
			requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			reviewId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			principalEmail: "ada@example.com",
			reviewerEmail: "ada@example.com",
			reviewerRole: "signer",
			reviewerRecipientId: selfSignRows(envelopeRecipients)[0]?.id,
			reviewerFieldsSnapshot: expect.stringContaining("signature"),
			reviewerFieldsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			documentId,
			documentTitle: "document.pdf",
			sourceDocumentId: selfSignRows(sourceDocuments)[0]?.id,
			sourceVersion: 1,
			sourceSha256: selfSignRows(sourceDocuments)[0]?.sha256,
			operation: "completeAgentSigning",
			state: "pending_human_review",
			actionPayload: expect.stringContaining("Ada Lovelace"),
			actionPayloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			createdAt: state.now,
			expiresAt: new Date("2026-07-18T10:00:00.000Z"),
			decisionAt: null,
			decidedByEmail: null,
			decidedBySessionId: null,
			terminalReason: null,
		}),
	);
	expect(JSON.stringify(command)).not.toContain(rawToken);
	expect(selfSignRows(fieldValues)).toHaveLength(0);
	expect(selfSignRows(finalDocuments)).toHaveLength(0);
}
