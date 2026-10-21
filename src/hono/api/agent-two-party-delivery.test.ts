import { agenticApiTokens, agenticSecurityEvents } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import {
	auditEvents,
	emailSendRecords,
	envelopeRecipients,
	envelopes,
	fieldValues,
	signerTokens,
} from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureText } from "@/test/pdf-fixtures";
import { approveAgentReview } from "./agent-human-review-test-helper";
import {
	agentSelfSignBucket,
	agentSelfSignTables,
	selfSignRows as rows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";

const rawToken = "signmos_agent_two_party_delivery";

vi.mock("@/db/setup", async () => {
	const { getAgentSelfSignTestDb } = await import("./agent-self-sign-test-db");
	return { getDb: getAgentSelfSignTestDb };
});

function headers(key: string, contentType = "application/json") {
	return {
		authorization: `Bearer ${rawToken}`,
		"content-type": contentType,
		"idempotency-key": key,
		"x-now": state.now.toISOString(),
	};
}

const deliveryEnv = {
	APP_BASE_URL: "https://signmos.test",
	CLOUDFLARE_ENV: "test",
	RESEND_API_KEY: "re_test_key",
	RESEND_FROM_EMAIL: "signing@signmos.test",
	RESEND_REPLY_TO_EMAIL: "reply@signmos.test",
};

async function createDraft(key: string): Promise<string> {
	const response = await apiHono.request("/api/v1/documents", {
		method: "POST",
		headers: headers(key),
		body: JSON.stringify({ name: "Grace Creator", signingMode: "me_and_another_signer" }),
	});
	return ((await response.json()) as { data: { documentId: string } }).data.documentId;
}

async function uploadSource(documentId: string, key: string, bucket: R2Bucket): Promise<void> {
	const response = await apiHono.request(
		`/api/v1/documents/${documentId}/source-pdf`,
		{
			method: "PUT",
			headers: headers(key, "application/pdf"),
			body: pdfFixtureText("two party delivery"),
		},
		{ DOCUMENTS_BUCKET: bucket },
	);
	expect(response.status).toBe(201);
}

async function addPartner(documentId: string, key: string): Promise<string> {
	const response = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
		method: "POST",
		headers: headers(key),
		body: JSON.stringify({
			recipients: [{ name: "Ada Partner", email: "partner@example.com" }],
		}),
	});
	return ((await response.json()) as { data: Array<{ id: string }> }).data[0]?.id ?? "";
}

async function placeDefaultFields(documentId: string, key: string): Promise<void> {
	const recipientIds = rows(envelopeRecipients).map((recipient) => String(recipient.id));
	const response = await apiHono.request(`/api/v1/documents/${documentId}/fields/defaults`, {
		method: "POST",
		headers: headers(key),
		body: JSON.stringify({ recipientIds, page: 1 }),
	});
	expect(response.status).toBe(201);
}

async function completeCreator(documentId: string, key: string): Promise<Response> {
	return apiHono.request(`/api/v1/documents/${documentId}/complete`, {
		method: "POST",
		headers: headers(key),
		body: JSON.stringify({
			signature: { kind: "typed", typedText: "Grace Creator", typedFont: "cursive" },
			rememberSignature: false,
			date: "2099-12-31",
		}),
	});
}

describe("agent two-party creator delivery", () => {
	beforeEach(async () => {
		state.rows = new Map(agentSelfSignTables.map((table) => [table, []]));
		state.r2Objects.clear();
		state.r2PutCounts.clear();
		state.now = new Date("2026-07-17T12:00:00.000Z");
		rows(agenticApiTokens).push({
			id: "a0000000-0000-4000-8000-000000000001",
			email: "creator@example.com",
			name: "Creator delivery token",
			tokenHash: await hashAgenticCredential(rawToken),
			tokenHint: "signmos_...very",
			status: "active",
			activeSlot: 1,
			lastUsedAt: null,
			revokedAt: null,
			createdAt: new Date("2026-07-17T08:00:00.000Z"),
		});
	});

	afterEach(() => vi.restoreAllMocks());

	it("agent command idempotency replays creator-sign, send, and resend without duplicates", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "resend-message" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const bucket = agentSelfSignBucket();
		const documentId = await createDraft("delivery-create");
		await uploadSource(documentId, "delivery-upload", bucket);
		const partnerId = await addPartner(documentId, "delivery-partner");
		await placeDefaultFields(documentId, "delivery-fields");

		const completed = await approveAgentReview(
			await apiHono.request(`/api/v1/documents/${documentId}/complete`, {
				method: "POST",
				headers: headers("delivery-creator-complete"),
				body: JSON.stringify({
					signature: {
						kind: "typed",
						typedText: "Grace Creator",
						typedFont: "cursive",
					},
					rememberSignature: false,
					date: "2099-12-31",
				}),
			}),
			{ email: "creator@example.com", key: "delivery-creator-approval" },
		);
		expect(completed.status).toBe(200);
		const completedBody = await completed.json();
		expect(completedBody).toEqual({
			data: expect.objectContaining({
				status: "completed",
				result: expect.objectContaining({ envelopeStatus: "draft", recipientStatus: "completed" }),
			}),
		});
		expect(rows(fieldValues)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ value: "Grace Creator" }),
				expect.objectContaining({ value: "2026-07-17" }),
			]),
		);
		const completionReplay = await apiHono.request(`/api/v1/documents/${documentId}/complete`, {
			method: "POST",
			headers: headers("delivery-creator-complete"),
			body: JSON.stringify({
				signature: {
					kind: "typed",
					typedText: "Grace Creator",
					typedFont: "cursive",
				},
				rememberSignature: false,
				date: "2099-12-31",
			}),
		});
		expect(completionReplay.status).toBe(200);
		await expect(completionReplay.json()).resolves.toEqual(completedBody);
		expect(rows(fieldValues)).toHaveLength(2);

		const sent = await apiHono.request(
			`/api/v1/documents/${documentId}/send`,
			{ method: "POST", headers: headers("delivery-send"), body: JSON.stringify({}) },
			deliveryEnv,
		);
		expect(sent.status).toBe(200);
		const sentBody = await sent.json();
		expect(JSON.stringify(sentBody)).not.toMatch(
			/signmos_|verification|signing-verifications|token/,
		);
		expect(sentBody).toEqual({
			data: expect.objectContaining({
				status: "sent",
				allowedActions: expect.arrayContaining(["resend_invitation"]),
			}),
		});
		expect(rows(envelopes)[0]).toEqual(expect.objectContaining({ status: "sent" }));
		expect(rows(envelopeRecipients)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ email: "creator@example.com", status: "completed" }),
				expect.objectContaining({ email: "partner@example.com", status: "sent" }),
			]),
		);
		expect(rows(emailSendRecords)).toEqual([
			expect.objectContaining({ email: "partner@example.com", kind: "partner_verification" }),
		]);
		expect(rows(signerTokens)).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const sendReplay = await apiHono.request(
			`/api/v1/documents/${documentId}/send`,
			{ method: "POST", headers: headers("delivery-send"), body: JSON.stringify({}) },
			deliveryEnv,
		);
		expect(sendReplay.status).toBe(200);
		await expect(sendReplay.json()).resolves.toEqual(sentBody);
		expect(rows(emailSendRecords)).toHaveLength(1);
		expect(rows(signerTokens)).toHaveLength(1);

		const resent = await apiHono.request(
			`/api/v1/documents/${documentId}/recipients/${partnerId}/resend`,
			{ method: "POST", headers: headers("delivery-resend"), body: JSON.stringify({}) },
			deliveryEnv,
		);
		expect(resent.status).toBe(201);
		const resentBody = await resent.json();
		expect(JSON.stringify(resentBody)).not.toMatch(/signmos_|verification|token/);
		expect(rows(emailSendRecords)).toHaveLength(2);
		expect(rows(signerTokens)).toHaveLength(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const resendReplay = await apiHono.request(
			`/api/v1/documents/${documentId}/recipients/${partnerId}/resend`,
			{ method: "POST", headers: headers("delivery-resend"), body: JSON.stringify({}) },
			deliveryEnv,
		);
		expect(resendReplay.status).toBe(201);
		await expect(resendReplay.json()).resolves.toEqual(resentBody);
		expect(rows(emailSendRecords)).toHaveLength(2);
		expect(rows(signerTokens)).toHaveLength(2);
		const changedOperation = await apiHono.request(
			`/api/v1/documents/${documentId}/send`,
			{ method: "POST", headers: headers("delivery-resend"), body: JSON.stringify({}) },
			deliveryEnv,
		);
		expect(changedOperation.status).toBe(409);
		await expect(changedOperation.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
		});

		const status = await apiHono.request(`/api/v1/documents/${documentId}/status`, {
			headers: headers("unused-status"),
		});
		expect(status.status).toBe(200);
		await expect(status.json()).resolves.toEqual({
			data: expect.objectContaining({
				status: "sent",
				participants: expect.arrayContaining([
					expect.objectContaining({ email: "creator@example.com", status: "completed" }),
					expect.objectContaining({ email: "partner@example.com", status: "sent" }),
				]),
			}),
		});
		for (const path of [`/api/v1/documents/${documentId}/history`]) {
			const response = await apiHono.request(path, { headers: headers("unused-status") });
			expect(response.status).toBe(200);
			expect(JSON.stringify(await response.json())).not.toMatch(/signmos_|verification|r2Key/);
		}
		for (const eventType of [
			"agentic.creator_signing.completed",
			"agentic.document.sent",
			"agentic.invitation.resent",
		]) {
			expect(rows(agenticSecurityEvents)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						eventType,
						documentId,
						email: "creator@example.com",
						tokenId: "a0000000-0000-4000-8000-000000000001",
						tokenName: "Creator delivery token",
					}),
				]),
			);
		}
		expect(JSON.stringify(rows(auditEvents))).not.toContain(rawToken);
		expect(JSON.stringify([...state.rows.values()])).not.toContain(rawToken);
	});

	it("returns actionable source, partner, field, and creator-signing preconditions", async () => {
		const bucket = agentSelfSignBucket();
		const documentId = await createDraft("precondition-create");
		const send = (key: string) =>
			apiHono.request(`/api/v1/documents/${documentId}/send`, {
				method: "POST",
				headers: headers(key),
				body: JSON.stringify({}),
			});
		const missingSource = await send("precondition-source");
		expect(missingSource.status).toBe(409);
		await expect(missingSource.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "SOURCE_PDF_REQUIRED",
				allowedActions: ["upload_source_pdf"],
				retryable: false,
				recoveryUrl: `/api/v1/documents/${documentId}/status`,
			}),
		});

		await uploadSource(documentId, "precondition-upload", bucket);
		const missingPartner = await send("precondition-partner");
		expect(missingPartner.status).toBe(409);
		await expect(missingPartner.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "PARTNER_RECIPIENT_REQUIRED",
				allowedActions: ["add_recipients"],
			}),
		});

		await addPartner(documentId, "precondition-add-partner");
		const missingFields = await send("precondition-fields");
		expect(missingFields.status).toBe(409);
		await expect(missingFields.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "RECIPIENT_FIELDS_REQUIRED",
				allowedActions: ["place_fields"],
			}),
		});

		await placeDefaultFields(documentId, "precondition-place-fields");
		const missingCreatorSigning = await send("precondition-creator-signing");
		expect(missingCreatorSigning.status).toBe(409);
		await expect(missingCreatorSigning.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "CREATOR_SIGNING_REQUIRED",
				allowedActions: ["complete_creator_signing"],
			}),
		});
		expect(rows(envelopes)[0]).toEqual(expect.objectContaining({ status: "draft" }));
	});

	it("replays a retryable provider failure without falsely sending or duplicating attempts", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "provider unavailable" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			}),
		);
		const bucket = agentSelfSignBucket();
		const documentId = await createDraft("provider-create");
		await uploadSource(documentId, "provider-upload", bucket);
		await addPartner(documentId, "provider-partner");
		await placeDefaultFields(documentId, "provider-fields");
		expect(
			(
				await approveAgentReview(await completeCreator(documentId, "provider-complete"), {
					email: "creator@example.com",
					key: "provider-complete-approval",
				})
			).status,
		).toBe(200);
		const request = () =>
			apiHono.request(
				`/api/v1/documents/${documentId}/send`,
				{ method: "POST", headers: headers("provider-send"), body: JSON.stringify({}) },
				deliveryEnv,
			);
		const failed = await request();
		const failedBody = await failed.json();
		expect(failed.status).toBe(502);
		expect(failedBody).toEqual({
			error: expect.objectContaining({
				code: "EMAIL_DELIVERY_FAILED",
				retryable: true,
				allowedActions: ["retry_send"],
			}),
		});
		expect(rows(envelopes)[0]).toEqual(expect.objectContaining({ status: "draft" }));
		expect(rows(emailSendRecords)).toHaveLength(0);
		expect(rows(auditEvents).some((event) => event.eventType === "envelope.sent")).toBe(false);

		const replay = await request();
		expect(replay.status).toBe(502);
		await expect(replay.json()).resolves.toEqual(failedBody);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(rows(signerTokens)).toHaveLength(1);
	});
});
