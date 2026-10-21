import { agenticApiTokens, agenticSecurityEvents } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { envelopes, fieldValues, finalDocuments } from "@/db/envelope";
import { hashHistoryCredential } from "@/db/history-access/request";
import { historySecurityEvents, historySessions } from "@/db/history-access/table";
import { apiHono } from "@/hono/api";
import { pdfFixtureText } from "@/test/pdf-fixtures";
import {
	agentSelfSignBucket,
	agentSelfSignTables,
	selfSignRows as rows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";
import { expectFinalizationRetryRecovery } from "./human-review-finalization-test-assertions";
import {
	expectFailedNotificationRemainsPending,
	expectMatchingQueueVisibility,
	expectSafeIdempotentNotification,
} from "./human-review-notification-test-assertions";
import {
	expectAssignedFieldInvalidation,
	expectDocumentIdentityInvalidation,
	expectExactExpiryBoundary,
	expectLifecycleChangeInvalidation,
	expectPayloadChangeInvalidation,
	expectPollingExpiryBoundary,
	expectReviewerRoleInvalidation,
	expectRevokedTokenInvalidation,
	expectSourceChangeInvalidation,
} from "./human-review-validity-test-assertions";

const rawAgentToken = "signmos_human_review_agent";
const agentTokenId = "a9000000-0000-4000-8000-000000000001";
const matchingSession = "matching-human-review-session";
const wrongSession = "wrong-human-review-session";
const completionPayload = {
	signature: { kind: "typed", typedText: "Ada Lovelace", typedFont: "cursive" },
	rememberSignature: false,
} as const;

vi.mock("@/db/setup", async () => {
	const { getAgentSelfSignTestDb } = await import("./agent-self-sign-test-db");
	return { getDb: getAgentSelfSignTestDb };
});

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

async function queueSelfSignReview(env?: Partial<Env>) {
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
	const queued = await apiHono.request(
		`/api/v1/documents/${documentId}/complete`,
		{
			method: "POST",
			headers: agentHeaders("human-review-complete"),
			body: JSON.stringify(completionPayload),
		},
		env as Env,
	);
	expect(queued.status).toBe(202);
	const command = (await queued.json()) as {
		data: {
			commandId: string;
			reviewUrl: string;
			statusUrl: string;
			notificationStatus: string;
		};
	};
	return { bucket, documentId, command };
}

function approveReview(
	command: { data: { reviewUrl: string } },
	now = state.now,
	env?: Partial<Env>,
) {
	const reviewPath = new URL(command.data.reviewUrl).pathname.replace(
		"/human-review/",
		"/api/history/human-reviews/",
	);
	return apiHono.request(
		`${reviewPath}/decision`,
		{
			method: "POST",
			headers: {
				...historyHeaders(matchingSession),
				"content-type": "application/json",
				origin: "http://localhost",
				"x-now": now.toISOString(),
			},
			body: JSON.stringify({ decision: "approve" }),
		},
		env as Env,
	);
}

describe("human review browser boundary", () => {
	beforeEach(async () => {
		state.rows = new Map(agentSelfSignTables.map((table) => [table, []]));
		state.r2Objects.clear();
		state.r2PutCounts.clear();
		state.r2DeleteCounts.clear();
		state.now = new Date("2026-07-17T10:00:00.000Z");
		rows(agenticApiTokens).push({
			id: agentTokenId,
			email: "ada@example.com",
			name: "Ada review agent",
			tokenHash: await hashAgenticCredential(rawAgentToken),
			tokenHint: "signmos_...gent",
			status: "active",
			activeSlot: 1,
			lastUsedAt: null,
			revokedAt: null,
			createdAt: new Date("2026-07-17T08:00:00.000Z"),
		});
		for (const [id, email, rawSession] of [
			["b9000000-0000-4000-8000-000000000001", "ada@example.com", matchingSession],
			["b9000000-0000-4000-8000-000000000002", "other@example.com", wrongSession],
		] as const) {
			rows(historySessions).push({
				id,
				linkId: crypto.randomUUID(),
				email,
				sessionHash: await hashHistoryCredential(rawSession),
				status: "active",
				expiresAt: new Date("2026-07-19T18:00:00.000Z"),
				revokedAt: null,
				createdAt: state.now,
			});
		}
	});

	it("allows only the matching verified human to inspect the exact pending action", async () => {
		const { bucket, documentId, command } = await queueSelfSignReview();
		const reviewPath = new URL(command.data.reviewUrl).pathname.replace(
			"/human-review/",
			"/api/history/human-reviews/",
		);

		const unauthenticated = await apiHono.request(reviewPath, {
			headers: { "x-now": state.now.toISOString() },
		});
		expect(unauthenticated.status).toBe(401);
		await expect(unauthenticated.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "HISTORY_SESSION_REQUIRED",
				recoveryUrl: expect.stringContaining(
					encodeURIComponent(new URL(command.data.reviewUrl).pathname),
				),
			}),
		});

		for (const rawSession of [wrongSession]) {
			const forbidden = await apiHono.request(reviewPath, { headers: historyHeaders(rawSession) });
			expect(forbidden.status).toBe(404);
			await expect(forbidden.json()).resolves.toEqual({
				error: expect.objectContaining({ code: "HUMAN_REVIEW_FORBIDDEN" }),
			});
		}

		const allowed = await apiHono.request(reviewPath, {
			headers: historyHeaders(matchingSession),
		});
		expect(allowed.status).toBe(200);
		await expect(allowed.json()).resolves.toEqual({
			data: expect.objectContaining({
				commandId: command.data.commandId,
				status: "pending_human_review",
				expiresAt: "2026-07-18T10:00:00.000Z",
				document: expect.objectContaining({
					documentId,
					title: "review-me.pdf",
					sourceVersion: 1,
					sourcePdfUrl: `${reviewPath}/source-pdf`,
				}),
				action: expect.objectContaining({
					kind: "complete",
					payload: expect.stringContaining("Ada Lovelace"),
					consequence: expect.stringContaining("sign"),
				}),
				agent: { name: "Ada review agent" },
			}),
		});
		const sourcePdf = await apiHono.request(
			`${reviewPath}/source-pdf`,
			{
				headers: historyHeaders(matchingSession),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(sourcePdf.status).toBe(200);
		expect(sourcePdf.headers.get("content-type")).toBe("application/pdf");
		expect(await sourcePdf.text()).toContain("human review fixture");
		const hiddenSource = await apiHono.request(
			`${reviewPath}/source-pdf`,
			{
				headers: historyHeaders(wrongSession),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(hiddenSource.status).toBe(404);
	});

	it("executes self-signing once only after explicit matching-human approval", async () => {
		const { bucket, documentId, command } = await queueSelfSignReview();
		const reviewPath = new URL(command.data.reviewUrl).pathname.replace(
			"/human-review/",
			"/api/history/human-reviews/",
		);
		const approved = await apiHono.request(
			`${reviewPath}/decision`,
			{
				method: "POST",
				headers: {
					...historyHeaders(matchingSession),
					"content-type": "application/json",
					origin: "http://localhost",
				},
				body: JSON.stringify({ decision: "approve" }),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(approved.status).toBe(200);
		const terminalBody = await approved.json();
		expect(terminalBody).toEqual({
			data: expect.objectContaining({
				commandId: command.data.commandId,
				status: "completed",
				notificationStatus: "fallback",
				result: expect.objectContaining({
					envelopeId: documentId,
					envelopeStatus: "completed",
				}),
			}),
		});
		expect(rows(envelopes)[0]?.status).toBe("completed");
		expect(rows(fieldValues)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ value: "Ada Lovelace" }),
				expect.objectContaining({ value: "2026-07-17" }),
			]),
		);
		expect(rows(fieldValues)).toHaveLength(2);
		expect(rows(finalDocuments)).toHaveLength(1);
		expect(
			rows(historySecurityEvents).filter((event) =>
				["human_review.approved", "human_review.executed"].includes(String(event.eventType)),
			),
		).toEqual([
			expect.objectContaining({
				sessionId: "b9000000-0000-4000-8000-000000000001",
				envelopeId: documentId,
				email: "ada@example.com",
				eventType: "human_review.approved",
			}),
			expect.objectContaining({
				sessionId: "b9000000-0000-4000-8000-000000000001",
				envelopeId: documentId,
				email: "ada@example.com",
				eventType: "human_review.executed",
			}),
		]);
		expect(JSON.stringify(rows(historySecurityEvents))).not.toContain(matchingSession);

		const polled = await apiHono.request(new URL(command.data.statusUrl).pathname, {
			headers: agentHeaders(),
		});
		expect(polled.status).toBe(200);
		await expect(polled.json()).resolves.toEqual(terminalBody);
		const replay = await apiHono.request(`/api/v1/documents/${documentId}/complete`, {
			method: "POST",
			headers: agentHeaders("human-review-complete"),
			body: JSON.stringify(completionPayload),
		});
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toEqual(terminalBody);
		expect(
			rows(agenticSecurityEvents).filter(
				(event) => event.eventType === "agentic.self_sign.completed",
			),
		).toHaveLength(1);
	});

	it("allows at most one execution when matching approvals race", async () => {
		const { bucket, command } = await queueSelfSignReview();
		const [first, second] = await Promise.all([
			approveReview(command, state.now, { DOCUMENTS_BUCKET: bucket }),
			approveReview(command, state.now, { DOCUMENTS_BUCKET: bucket }),
		]);
		expect([first.status, second.status].sort()).toEqual([200, 409]);
		const winner = first.status === 200 ? first : second;
		const loser = first.status === 409 ? first : second;
		await expect(winner.json()).resolves.toEqual({
			data: expect.objectContaining({ status: "completed" }),
		});
		await expect(loser.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "HUMAN_REVIEW_ALREADY_DECIDED" }),
		});
		expect(rows(fieldValues)).toHaveLength(2);
		expect(rows(finalDocuments)).toHaveLength(1);
		expect(
			rows(agenticSecurityEvents).filter(
				(event) => event.eventType === "agentic.self_sign.completed",
			),
		).toHaveLength(1);
	});

	it("records an execution failure as terminal instead of leaving approval in progress", async () => {
		const { bucket, documentId, command } = await queueSelfSignReview();
		const failingBucket = {
			...bucket,
			get: async () => {
				throw new Error("synthetic R2 execution failure");
			},
		} as R2Bucket;
		const failed = await approveReview(command, state.now, { DOCUMENTS_BUCKET: failingBucket });
		expect(failed.status).toBe(200);
		const terminalBody = await failed.json();
		expect(terminalBody).toEqual({
			data: expect.objectContaining({
				commandId: command.data.commandId,
				status: "failed",
				error: expect.objectContaining({ code: "HUMAN_REVIEW_EXECUTION_FAILED" }),
			}),
		});
		const polled = await apiHono.request(new URL(command.data.statusUrl).pathname, {
			headers: agentHeaders(),
		});
		expect(polled.status).toBe(200);
		await expect(polled.json()).resolves.toEqual(terminalBody);
		const replay = await apiHono.request(`/api/v1/documents/${documentId}/complete`, {
			method: "POST",
			headers: agentHeaders("human-review-complete"),
			body: JSON.stringify(completionPayload),
		});
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toEqual(terminalBody);
		expect(rows(finalDocuments)).toHaveLength(0);
		expect(
			rows(historySecurityEvents).filter(
				(event) => event.eventType === "human_review.execution_failed",
			),
		).toHaveLength(1);
		await expectFinalizationRetryRecovery({
			documentId,
			bucket,
			completionPayload,
			agentHeaders,
			approveReview,
		});
	});

	it("records matching-human rejection as terminal without signing", async () => {
		const { documentId, command } = await queueSelfSignReview();
		const reviewPath = new URL(command.data.reviewUrl).pathname.replace(
			"/human-review/",
			"/api/history/human-reviews/",
		);
		const rejected = await apiHono.request(`${reviewPath}/decision`, {
			method: "POST",
			headers: {
				...historyHeaders(matchingSession),
				"content-type": "application/json",
				origin: "http://localhost",
			},
			body: JSON.stringify({ decision: "reject" }),
		});
		expect(rejected.status).toBe(200);
		const terminalBody = await rejected.json();
		expect(terminalBody).toEqual({
			data: {
				commandId: command.data.commandId,
				status: "rejected",
				notificationStatus: "fallback",
				error: expect.objectContaining({ code: "HUMAN_REVIEW_REJECTED" }),
			},
		});
		expect(rows(envelopes)[0]?.status).toBe("sent");
		expect(rows(fieldValues)).toHaveLength(0);
		expect(rows(finalDocuments)).toHaveLength(0);

		const polled = await apiHono.request(new URL(command.data.statusUrl).pathname, {
			headers: agentHeaders(),
		});
		expect(polled.status).toBe(200);
		await expect(polled.json()).resolves.toEqual(terminalBody);
		const replay = await apiHono.request(`/api/v1/documents/${documentId}/complete`, {
			method: "POST",
			headers: agentHeaders("human-review-complete"),
			body: JSON.stringify(completionPayload),
		});
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toEqual(terminalBody);
		const repeated = await apiHono.request(`${reviewPath}/decision`, {
			method: "POST",
			headers: {
				...historyHeaders(matchingSession),
				"content-type": "application/json",
				origin: "http://localhost",
			},
			body: JSON.stringify({ decision: "approve" }),
		});
		expect(repeated.status).toBe(409);
		await expect(repeated.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "HUMAN_REVIEW_ALREADY_DECIDED" }),
		});
	});

	it("is active immediately before 24 hours and expires exactly at the boundary", async () => {
		await expectExactExpiryBoundary();
	});

	it("polling transitions an untouched pending command at the exact expiry boundary", async () => {
		await expectPollingExpiryBoundary();
	});

	it("invalidates approval when the bound source PDF changes", async () => {
		await expectSourceChangeInvalidation();
	});

	it("invalidates approval when the bound document lifecycle changes", async () => {
		await expectLifecycleChangeInvalidation();
	});

	it("invalidates approval when the bound document identity changes", async () => {
		await expectDocumentIdentityInvalidation();
	});

	it("invalidates approval when the bound action payload changes", async () => {
		await expectPayloadChangeInvalidation();
	});

	it("invalidates approval when the originating personal token is revoked", async () => {
		await expectRevokedTokenInvalidation();
	});

	it("invalidates approval when the reviewer no longer has the bound signer role", async () => {
		await expectReviewerRoleInvalidation();
	});

	it("invalidates approval when an assigned field changes after review creation", async () => {
		await expectAssignedFieldInvalidation();
	});

	it("sends one safe server-addressed review notification after persisting the intent", async () => {
		await expectSafeIdempotentNotification();
	});

	it("keeps a failed notification pending and recoverable without authorizing execution", async () => {
		await expectFailedNotificationRemainsPending();
	});

	it("lists the pending review only in the matching human's My Documents queue", async () => {
		await expectMatchingQueueVisibility();
	});
});
