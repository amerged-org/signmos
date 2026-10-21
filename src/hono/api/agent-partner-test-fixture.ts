import { agenticApiTokens } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { envelopeRecipients } from "@/db/envelope";
import { hashHistoryCredential } from "@/db/history-access/request";
import { historySessions } from "@/db/history-access/table";
import { apiHono } from "@/hono/api";
import {
	agentSelfSignBucket,
	agentSelfSignTables,
	contractPdfFixture,
	selfSignRows as rows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";

export const creatorToken = "signmos_partner_fixture_creator";
export const partnerToken = "signmos_partner_fixture_signer";
export const outsiderToken = "signmos_partner_fixture_outsider";

export const partnerDeliveryEnv = {
	APP_BASE_URL: "https://signmos.test",
	CLOUDFLARE_ENV: "test",
	RESEND_API_KEY: "re_test_key",
	RESEND_FROM_EMAIL: "signing@signmos.test",
	RESEND_REPLY_TO_EMAIL: "reply@signmos.test",
};

export function agentHeaders(token: string, key?: string, contentType = "application/json") {
	return {
		authorization: `Bearer ${token}`,
		"content-type": contentType,
		...(key ? { "idempotency-key": key } : {}),
		"x-now": state.now.toISOString(),
	};
}

export async function resetAgentPartnerFixture(): Promise<void> {
	state.rows = new Map(agentSelfSignTables.map((table) => [table, []]));
	state.r2Objects.clear();
	state.r2PutCounts.clear();
	state.r2DeleteCounts.clear();
	state.now = new Date("2026-07-17T12:34:56.000Z");
	rows(agenticApiTokens).push(
		await tokenRow({
			id: "a1000000-0000-4000-8000-000000000001",
			email: "creator@example.com",
			name: "Creator personal token",
			rawToken: creatorToken,
		}),
		await tokenRow({
			id: "a1000000-0000-4000-8000-000000000002",
			email: "PARTNER@Example.COM",
			name: "Partner personal token",
			rawToken: partnerToken,
		}),
		await tokenRow({
			id: "a1000000-0000-4000-8000-000000000003",
			email: "outsider@example.com",
			name: "Outsider personal token",
			rawToken: outsiderToken,
		}),
	);
}

export async function createSentTwoPartyFixture(input: {
	keyPrefix: string;
	fetchMock?: ReturnType<typeof vi.spyOn>;
}): Promise<{
	documentId: string;
	creatorId: string;
	partnerId: string;
	bucket: R2Bucket;
}> {
	input.fetchMock?.mockResolvedValue(
		new Response(JSON.stringify({ id: "resend-message" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	const bucket = agentSelfSignBucket();
	const create = await apiHono.request("/api/v1/documents", {
		method: "POST",
		headers: agentHeaders(creatorToken, `${input.keyPrefix}-create`),
		body: JSON.stringify({ name: "Grace Creator", signingMode: "me_and_another_signer" }),
	});
	assertStatus(create, 201, "create two-party draft");
	const documentId = ((await create.json()) as { data: { documentId: string } }).data.documentId;

	const upload = await apiHono.request(
		`/api/v1/documents/${documentId}/source-pdf`,
		{
			method: "PUT",
			headers: agentHeaders(creatorToken, `${input.keyPrefix}-upload`, "application/pdf"),
			body: await contractPdfFixture(),
		},
		{ DOCUMENTS_BUCKET: bucket },
	);
	assertStatus(upload, 201, "upload source PDF");

	const add = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
		method: "POST",
		headers: agentHeaders(creatorToken, `${input.keyPrefix}-recipient`),
		body: JSON.stringify({
			recipients: [{ name: "Ada Partner", email: " partner@example.com " }],
		}),
	});
	assertStatus(add, 201, "add partner recipient");
	const partnerId = ((await add.json()) as { data: Array<{ id: string }> }).data[0]?.id;
	const creatorId = rows(envelopeRecipients).find(
		(recipient) => recipient.email === "creator@example.com",
	)?.id;
	if (typeof creatorId !== "string" || typeof partnerId !== "string") {
		throw new Error("Partner fixture recipient ids were not created");
	}

	const fields = await apiHono.request(`/api/v1/documents/${documentId}/fields/defaults`, {
		method: "POST",
		headers: agentHeaders(creatorToken, `${input.keyPrefix}-fields`),
		body: JSON.stringify({ recipientIds: [creatorId, partnerId], page: 1 }),
	});
	assertStatus(fields, 201, "place two-party fields");

	const creatorComplete = await apiHono.request(`/api/v1/documents/${documentId}/complete`, {
		method: "POST",
		headers: agentHeaders(creatorToken, `${input.keyPrefix}-creator-complete`),
		body: JSON.stringify({
			signature: { kind: "typed", typedText: "Grace Creator", typedFont: "cursive" },
			rememberSignature: false,
			date: "2099-12-31",
		}),
	});
	assertStatus(creatorComplete, 202, "queue creator field completion review");
	const creatorReview = (await creatorComplete.json()) as { data: { reviewUrl: string } };
	const rawSession = `${input.keyPrefix}-creator-review-session`;
	rows(historySessions).push({
		id: crypto.randomUUID(),
		linkId: crypto.randomUUID(),
		email: "creator@example.com",
		sessionHash: await hashHistoryCredential(rawSession),
		status: "active",
		expiresAt: new Date(state.now.getTime() + 60 * 60 * 1000),
		revokedAt: null,
		createdAt: state.now,
	});
	const reviewId = new URL(creatorReview.data.reviewUrl).pathname.split("/").at(-1);
	const creatorApproval = await apiHono.request(`/api/history/human-reviews/${reviewId}/decision`, {
		method: "POST",
		headers: {
			cookie: `signmos_history_session=${rawSession}`,
			"content-type": "application/json",
			origin: "http://localhost",
			"x-now": state.now.toISOString(),
		},
		body: JSON.stringify({ decision: "approve" }),
	});
	assertStatus(creatorApproval, 200, "approve creator field completion review");

	const send = await apiHono.request(
		`/api/v1/documents/${documentId}/send`,
		{
			method: "POST",
			headers: agentHeaders(creatorToken, `${input.keyPrefix}-send`),
			body: JSON.stringify({}),
		},
		partnerDeliveryEnv,
	);
	assertStatus(send, 200, "send two-party document");
	return { documentId, creatorId, partnerId, bucket };
}

async function tokenRow(input: { id: string; email: string; name: string; rawToken: string }) {
	return {
		id: input.id,
		email: input.email,
		name: input.name,
		tokenHash: await hashAgenticCredential(input.rawToken),
		tokenHint: "signmos_...safe",
		status: "active",
		activeSlot: 1,
		lastUsedAt: null,
		revokedAt: null,
		createdAt: new Date("2026-07-17T08:00:00.000Z"),
	};
}

function assertStatus(response: Response, expected: number, action: string): void {
	if (response.status !== expected) {
		throw new Error(`${action} returned ${response.status}; expected ${expected}`);
	}
}
