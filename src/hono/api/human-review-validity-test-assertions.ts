import { agenticApiTokens, agenticCommandRecords } from "@/db/agentic-access";
import {
	envelopeFields,
	envelopeRecipients,
	envelopes,
	finalDocuments,
	sourceDocuments,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureText } from "@/test/pdf-fixtures";
import {
	agentSelfSignBucket,
	selfSignRows as rows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";

const rawAgentToken = "signmos_human_review_agent";
const agentTokenId = "a9000000-0000-4000-8000-000000000001";
const matchingSession = "matching-human-review-session";
const completionPayload = {
	signature: { kind: "typed", typedText: "Ada Lovelace", typedFont: "cursive" },
	rememberSignature: false,
} as const;

function agentHeaders(key?: string, contentType = "application/json") {
	return {
		authorization: `Bearer ${rawAgentToken}`,
		"content-type": contentType,
		...(key ? { "idempotency-key": key } : {}),
		"x-now": state.now.toISOString(),
	};
}

function historyHeaders(rawSession: string) {
	return {
		cookie: `signmos_history_session=${rawSession}`,
		"x-now": state.now.toISOString(),
	};
}

async function queueSelfSignReview() {
	const bucket = agentSelfSignBucket();
	const created = await apiHono.request("/api/v1/documents", {
		method: "POST",
		headers: agentHeaders("human-review-create"),
		body: JSON.stringify({ name: "Ada Lovelace" }),
	});
	const documentId = ((await created.json()) as { data: { documentId: string } }).data.documentId;
	const uploaded = await apiHono.request(
		`/api/v1/documents/${documentId}/source-pdf`,
		{
			method: "PUT",
			headers: {
				...agentHeaders("human-review-upload", "application/pdf"),
				"x-source-filename": "review-me.pdf",
			},
			body: pdfFixtureText("human review fixture"),
		},
		{ DOCUMENTS_BUCKET: bucket },
	);
	expect(uploaded.status).toBe(201);
	const fields = await apiHono.request(`/api/v1/documents/${documentId}/fields/defaults`, {
		method: "POST",
		headers: agentHeaders("human-review-fields"),
		body: JSON.stringify({ page: 1 }),
	});
	expect(fields.status).toBe(201);
	const queued = await apiHono.request(`/api/v1/documents/${documentId}/complete`, {
		method: "POST",
		headers: agentHeaders("human-review-complete"),
		body: JSON.stringify(completionPayload),
	});
	expect(queued.status).toBe(202);
	const command = (await queued.json()) as {
		data: { commandId: string; reviewUrl: string; statusUrl: string };
	};
	return { command };
}

function approveReview(command: { data: { reviewUrl: string } }) {
	const reviewPath = new URL(command.data.reviewUrl).pathname.replace(
		"/human-review/",
		"/api/history/human-reviews/",
	);
	return apiHono.request(`${reviewPath}/decision`, {
		method: "POST",
		headers: {
			...historyHeaders(matchingSession),
			"content-type": "application/json",
			origin: "http://localhost",
		},
		body: JSON.stringify({ decision: "approve" }),
	});
}

export async function expectExactExpiryBoundary() {
	const { command } = await queueSelfSignReview();
	const reviewPath = new URL(command.data.reviewUrl).pathname.replace(
		"/human-review/",
		"/api/history/human-reviews/",
	);
	const expiresAt = new Date("2026-07-18T10:00:00.000Z");
	const before = await apiHono.request("/api/history/human-reviews", {
		headers: {
			...historyHeaders(matchingSession),
			"x-now": new Date(expiresAt.getTime() - 1).toISOString(),
		},
	});
	expect(before.status).toBe(200);
	expect(JSON.stringify(await before.json())).toContain(command.data.commandId);

	const expired = await apiHono.request(`${reviewPath}/decision`, {
		method: "POST",
		headers: {
			...historyHeaders(matchingSession),
			"content-type": "application/json",
			origin: "http://localhost",
			"x-now": expiresAt.toISOString(),
		},
		body: JSON.stringify({ decision: "approve" }),
	});
	expect(expired.status).toBe(410);
	await expect(expired.json()).resolves.toEqual({
		error: expect.objectContaining({ code: "HUMAN_REVIEW_EXPIRED" }),
	});
	const polled = await apiHono.request(new URL(command.data.statusUrl).pathname, {
		headers: agentHeaders(),
	});
	expect(polled.status).toBe(200);
	await expect(polled.json()).resolves.toEqual({
		data: expect.objectContaining({
			commandId: command.data.commandId,
			status: "expired",
			error: expect.objectContaining({ code: "HUMAN_REVIEW_EXPIRED" }),
		}),
	});
	expect(rows(envelopes)[0]?.status).toBe("sent");
	expect(rows(finalDocuments)).toHaveLength(0);
}

export async function expectPollingExpiryBoundary() {
	const { command } = await queueSelfSignReview();
	const expiresAt = "2026-07-18T10:00:00.000Z";
	const polled = await apiHono.request(new URL(command.data.statusUrl).pathname, {
		headers: { ...agentHeaders(), "x-now": expiresAt },
	});
	expect(polled.status).toBe(200);
	await expect(polled.json()).resolves.toEqual({
		data: expect.objectContaining({
			commandId: command.data.commandId,
			status: "expired",
			error: expect.objectContaining({ code: "HUMAN_REVIEW_EXPIRED" }),
		}),
	});
	expect(rows(finalDocuments)).toHaveLength(0);
}

async function expectInvalidatedAfter(
	changeBinding: (command: { data: { commandId: string } }) => void,
) {
	const { command } = await queueSelfSignReview();
	changeBinding(command);
	const response = await approveReview(command);
	expect(response.status).toBe(409);
	await expect(response.json()).resolves.toEqual({
		error: expect.objectContaining({ code: "HUMAN_REVIEW_INVALIDATED" }),
	});
	expect(rows(finalDocuments)).toHaveLength(0);
	return command;
}

export async function expectSourceChangeInvalidation() {
	const command = await expectInvalidatedAfter(() => {
		const source = rows(sourceDocuments)[0];
		if (!source) throw new Error("human review source fixture missing");
		source.sha256 = "f".repeat(64);
	});
	const polled = await apiHono.request(new URL(command.data.statusUrl).pathname, {
		headers: agentHeaders(),
	});
	await expect(polled.json()).resolves.toEqual({
		data: expect.objectContaining({
			status: "invalidated",
			error: expect.objectContaining({ code: "HUMAN_REVIEW_INVALIDATED" }),
		}),
	});
}

export async function expectLifecycleChangeInvalidation() {
	const command = await expectInvalidatedAfter(() => {
		const envelope = rows(envelopes)[0];
		if (!envelope) throw new Error("human review envelope fixture missing");
		envelope.status = "expired";
	});
	const polled = await apiHono.request(new URL(command.data.statusUrl).pathname, {
		headers: agentHeaders(),
	});
	await expect(polled.json()).resolves.toEqual({
		data: expect.objectContaining({ status: "invalidated" }),
	});
}

export async function expectDocumentIdentityInvalidation() {
	await expectInvalidatedAfter((command) => {
		const record = rows(agenticCommandRecords).find(
			(candidate) => candidate.id === command.data.commandId,
		);
		if (!record) throw new Error("human review command fixture missing");
		record.documentId = "e9000000-0000-4000-8000-000000000099";
	});
}

export async function expectPayloadChangeInvalidation() {
	await expectInvalidatedAfter((command) => {
		const record = rows(agenticCommandRecords).find(
			(candidate) => candidate.id === command.data.commandId,
		);
		if (!record) throw new Error("human review command fixture missing");
		record.actionPayload = JSON.stringify({ ...completionPayload, rememberSignature: true });
	});
}

export async function expectRevokedTokenInvalidation() {
	await expectInvalidatedAfter(() => {
		const token = rows(agenticApiTokens).find((candidate) => candidate.id === agentTokenId);
		if (!token) throw new Error("human review token fixture missing");
		token.status = "revoked";
	});
}

export async function expectReviewerRoleInvalidation() {
	await expectInvalidatedAfter(() => {
		const recipient = rows(envelopeRecipients)[0];
		if (!recipient) throw new Error("human review recipient fixture missing");
		recipient.email = "replacement@example.com";
	});
}

export async function expectAssignedFieldInvalidation() {
	await expectInvalidatedAfter(() => {
		const field = rows(envelopeFields)[0];
		if (!field) throw new Error("human review field fixture missing");
		field.x = Number(field.x) + 1;
	});
}
