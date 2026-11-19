import { agenticCommandRecords, agenticSecurityEvents } from "@/db/agentic-access";
import { envelopes, fieldValues, finalDocuments } from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureText } from "@/test/pdf-fixtures";
import {
	agentSelfSignBucket,
	selfSignRows as rows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";

const rawAgentToken = "signmos_human_review_agent";
const matchingSession = "matching-human-review-session";
const wrongSession = "wrong-human-review-session";
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
		data: { commandId: string; reviewUrl: string; statusUrl: string; notificationStatus: string };
	};
	return { documentId, command };
}

const resendEnv = {
	APP_BASE_URL: "https://signmos.example",
	CLOUDFLARE_ENV: "development",
	RESEND_API_KEY: "re_review",
	RESEND_FROM_EMAIL: "Signmos <sign@signmos.example>",
	RESEND_REPLY_TO_EMAIL: "support@signmos.example",
};

export async function expectSafeIdempotentNotification() {
	const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		expect(
			rows(agenticCommandRecords).filter((record) => record.state === "pending_human_review"),
		).toEqual([
			expect.objectContaining({
				state: "pending_human_review",
				reviewerEmail: "ada@example.com",
			}),
		]);
		const email = JSON.parse(String(init?.body)) as {
			to: string[];
			subject: string;
			text: string;
			html: string;
		};
		expect(email.to).toEqual(["ada@example.com"]);
		expect(email.subject).toBe("Freigabe angefragt: review-me.pdf · amerged Sign");
		expect(email.text).toContain("review-me.pdf");
		expect(email.text).toContain("Sign and complete");
		expect(email.text).toContain("Ada review agent");
		expect(email.text).toContain("In amerged Sign prüfen");
		expect(email.text).not.toContain("Ada Lovelace");
		expect(JSON.stringify(email)).not.toContain(rawAgentToken);
		return new Response(JSON.stringify({ id: "resend-review-1" }), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	const { documentId, command } = await queueSelfSignReview(resendEnv);
	expect(command.data.notificationStatus).toBe("sent");
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const reviewAudit = rows(agenticSecurityEvents).filter((event) =>
		String(event.eventType).startsWith("agentic.human_review"),
	);
	expect(reviewAudit).toEqual([
		expect.objectContaining({
			tokenId: "a9000000-0000-4000-8000-000000000001",
			tokenName: "Ada review agent",
			documentId,
			email: "ada@example.com",
			eventType: "agentic.human_review.signing_requested",
			actorType: "agent",
		}),
		expect.objectContaining({
			tokenId: "a9000000-0000-4000-8000-000000000001",
			documentId,
			eventType: "agentic.human_review.notification.sent",
			actorType: "agent",
		}),
	]);
	expect(JSON.stringify(reviewAudit)).not.toContain(rawAgentToken);
	expect(
		rows(agenticCommandRecords).find((record) => record.id === command.data.commandId),
	).toEqual(
		expect.objectContaining({
			notificationStatus: "sent",
			notificationProviderMessage: "resend-review-1",
		}),
	);

	const replay = await apiHono.request(
		`/api/v1/documents/${documentId}/complete`,
		{
			method: "POST",
			headers: agentHeaders("human-review-complete"),
			body: JSON.stringify(completionPayload),
		},
		resendEnv as Env,
	);
	expect(replay.status).toBe(202);
	await expect(replay.json()).resolves.toEqual(command);
	expect(fetchMock).toHaveBeenCalledTimes(1);
}

export async function expectFailedNotificationRemainsPending() {
	const fetchMock = vi.fn(async () => new Response("provider unavailable", { status: 503 }));
	vi.stubGlobal("fetch", fetchMock);
	const { documentId, command } = await queueSelfSignReview(resendEnv);
	expect(command.data.notificationStatus).toBe("failed");
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(
		rows(agenticSecurityEvents)
			.filter((event) => String(event.eventType).startsWith("agentic.human_review"))
			.map((event) => event.eventType),
	).toEqual(["agentic.human_review.signing_requested", "agentic.human_review.notification.failed"]);
	expect(rows(envelopes)[0]?.status).toBe("sent");
	expect(rows(fieldValues)).toHaveLength(0);
	expect(rows(finalDocuments)).toHaveLength(0);

	const queue = await apiHono.request("/api/history/human-reviews", {
		headers: historyHeaders(matchingSession),
	});
	expect(queue.status).toBe(200);
	expect(JSON.stringify(await queue.json())).toContain(command.data.commandId);
	const replay = await apiHono.request(
		`/api/v1/documents/${documentId}/complete`,
		{
			method: "POST",
			headers: agentHeaders("human-review-complete"),
			body: JSON.stringify(completionPayload),
		},
		resendEnv as Env,
	);
	expect(replay.status).toBe(202);
	await expect(replay.json()).resolves.toEqual(command);
	expect(fetchMock).toHaveBeenCalledTimes(1);
}

export async function expectMatchingQueueVisibility() {
	const { documentId, command } = await queueSelfSignReview();
	const matching = await apiHono.request("/api/history/human-reviews", {
		headers: historyHeaders(matchingSession),
	});
	expect(matching.status).toBe(200);
	await expect(matching.json()).resolves.toEqual({
		data: {
			items: [
				expect.objectContaining({
					commandId: command.data.commandId,
					documentId,
					title: "review-me.pdf",
					actionLabel: "Sign and complete",
					agentName: "Ada review agent",
					status: "pending_human_review",
					reviewUrl: new URL(command.data.reviewUrl).pathname,
				}),
			],
		},
	});
	const wrong = await apiHono.request("/api/history/human-reviews", {
		headers: historyHeaders(wrongSession),
	});
	expect(wrong.status).toBe(200);
	await expect(wrong.json()).resolves.toEqual({ data: { items: [] } });
}
