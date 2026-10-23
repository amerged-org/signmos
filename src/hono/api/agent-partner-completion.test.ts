import { agenticApiTokens, agenticSecurityEvents } from "@/db/agentic-access";
import {
	auditEvents,
	emailSendRecords,
	envelopeFields,
	envelopeRecipients,
	envelopes,
	fieldValues,
	finalDocuments,
	signatureProfiles,
	signerTokens,
} from "@/db/envelope";
import { hashHistoryCredential } from "@/db/history-access/request";
import { historySessions } from "@/db/history-access/table";
import { apiHono } from "@/hono/api";
import {
	agentHeaders,
	createSentTwoPartyFixture,
	creatorToken,
	outsiderToken,
	partnerDeliveryEnv,
	partnerToken,
	resetAgentPartnerFixture,
} from "./agent-partner-test-fixture";
import { selfSignRows as rows } from "./agent-self-sign-test-db";

vi.mock("@/db/setup", async () => {
	const { getAgentSelfSignTestDb } = await import("./agent-self-sign-test-db");
	return { getDb: getAgentSelfSignTestDb };
});

describe("agent partner completion", () => {
	beforeEach(resetAgentPartnerFixture);
	afterEach(() => vi.restoreAllMocks());

	it("queues partner completion for human review without signing the document", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const { documentId, partnerId, bucket } = await createSentTwoPartyFixture({
			keyPrefix: "partner-complete-review",
			fetchMock,
		});
		const response = await apiHono.request(
			`/api/v1/documents/${documentId}/complete`,
			{
				method: "POST",
				headers: agentHeaders(partnerToken, "partner-complete-review-command"),
				body: JSON.stringify({
					signature: { kind: "typed", typedText: "Ada Partner", typedFont: "cursive" },
					rememberSignature: false,
				}),
			},
			{ ...partnerDeliveryEnv, DOCUMENTS_BUCKET: bucket },
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			data: expect.objectContaining({
				status: "pending_human_review",
				notificationStatus: "sent",
			}),
		});
		expect(rows(envelopes)[0]?.status).toBe("sent");
		expect(rows(envelopeRecipients).find((row) => row.id === partnerId)?.status).toBe("sent");
		expect(rows(fieldValues).filter((row) => row.recipientId === partnerId)).toHaveLength(0);
		expect(rows(finalDocuments)).toHaveLength(0);
		expect(
			rows(agenticSecurityEvents).filter(
				(row) =>
					row.eventType === "agentic.human_review.signing_requested" &&
					row.email === "partner@example.com",
			),
		).toHaveLength(1);
	});

	it("discovers only assigned current content and completes a multi-token flow idempotently", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const { documentId, partnerId, bucket } = await createSentTwoPartyFixture({
			keyPrefix: "partner-complete",
			fetchMock,
		});
		const processToken = String(rows(signerTokens)[0]?.token);

		const catalog = await apiHono.request("/api/v1/documents", {
			headers: agentHeaders(partnerToken),
		});
		expect(catalog.status).toBe(200);
		const catalogBody = await catalog.json();
		expect(catalogBody).toEqual({
			data: expect.objectContaining({
				identity: { email: "partner@example.com" },
				documents: [
					expect.objectContaining({
						documentId,
						role: "signer",
						allowedActions: ["sign"],
					}),
				],
			}),
		});
		expect(JSON.stringify(catalogBody)).not.toContain(processToken);

		const task = await apiHono.request(`/api/v1/documents/${documentId}/signing-task`, {
			headers: agentHeaders(partnerToken),
		});
		expect(task.status).toBe(200);
		const taskBody = (await task.json()) as {
			data: {
				recipientId: string;
				fields: Array<{ id: string }>;
				previewFields: Array<{ id: string }>;
			};
		};
		expect(taskBody.data.recipientId).toBe(partnerId);
		expect(taskBody.data.fields).toHaveLength(2);
		expect(taskBody.data.previewFields).toHaveLength(2);
		for (const field of [...taskBody.data.fields, ...taskBody.data.previewFields]) {
			expect(rows(envelopeFields).find((candidate) => candidate.id === field.id)?.recipientId).toBe(
				partnerId,
			);
		}

		const fields = await apiHono.request(`/api/v1/documents/${documentId}/fields`, {
			headers: agentHeaders(partnerToken),
		});
		expect(fields.status).toBe(200);
		expect(((await fields.json()) as { data: unknown[] }).data).toHaveLength(2);
		const source = await apiHono.request(`/api/v1/documents/${documentId}/source-pdf`, {
			headers: agentHeaders(partnerToken),
		});
		expect(source.status).toBe(200);
		expect(await source.json()).toEqual({
			data: expect.objectContaining({ documentId, version: 1 }),
		});
		const content = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf/content`,
			{ headers: agentHeaders(partnerToken) },
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(content.status).toBe(200);
		expect(content.headers.get("content-type")).toBe("application/pdf");

		const completeRequest = {
			signature: { kind: "drawn", label: "Ada drawn", svgPath: "M 1 1 L 40 20" },
			rememberSignature: true,
			date: "2099-12-31",
		};
		const complete = () =>
			apiHono.request(
				`/api/v1/documents/${documentId}/complete`,
				{
					method: "POST",
					headers: agentHeaders(partnerToken, "partner-complete-command"),
					body: JSON.stringify(completeRequest),
				},
				{ ...partnerDeliveryEnv, DOCUMENTS_BUCKET: bucket },
			);
		const completed = await complete();
		expect(completed.status).toBe(202);
		const queued = (await completed.json()) as { data: { reviewUrl: string } };
		const rawSession = "partner-completion-review-session";
		rows(historySessions).push({
			id: "b7000000-0000-4000-8000-000000000001",
			linkId: "b7000000-0000-4000-8000-000000000002",
			email: "partner@example.com",
			sessionHash: await hashHistoryCredential(rawSession),
			status: "active",
			expiresAt: new Date("2026-07-18T12:34:56.000Z"),
			revokedAt: null,
			createdAt: new Date("2026-07-17T12:34:56.000Z"),
		});
		const reviewPath = new URL(queued.data.reviewUrl).pathname.replace(
			"/human-review/",
			"/api/history/human-reviews/",
		);
		const approved = await apiHono.request(
			`${reviewPath}/decision`,
			{
				method: "POST",
				headers: {
					cookie: `signmos_history_session=${rawSession}`,
					"content-type": "application/json",
					origin: "http://localhost",
					"x-now": "2026-07-17T12:34:56.000Z",
				},
				body: JSON.stringify({ decision: "approve" }),
			},
			{ ...partnerDeliveryEnv, DOCUMENTS_BUCKET: bucket },
		);
		expect(approved.status).toBe(200);
		const completedBody = await approved.json();
		expect(completedBody).toEqual({
			data: expect.objectContaining({
				status: "completed",
				result: expect.objectContaining({
					envelopeId: documentId,
					recipientId: partnerId,
					recipientStatus: "completed",
					envelopeStatus: "completed",
				}),
			}),
		});
		expect(rows(envelopes)[0]?.status).toBe("completed");
		expect(rows(envelopeRecipients).find((row) => row.id === partnerId)?.status).toBe("completed");
		expect(rows(fieldValues).filter((row) => row.recipientId === partnerId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ value: "M 1 1 L 40 20" }),
				expect.objectContaining({ value: "2026-07-17" }),
			]),
		);
		expect(rows(signatureProfiles)).toEqual(
			expect.arrayContaining([expect.objectContaining({ createdBy: "partner@example.com" })]),
		);
		expect(rows(finalDocuments)).toHaveLength(1);

		const replay = await complete();
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toEqual(completedBody);
		expect(rows(fieldValues).filter((row) => row.recipientId === partnerId)).toHaveLength(2);
		expect(
			rows(emailSendRecords).filter((row) => row.kind === "partner_signed_notice_requested"),
		).toHaveLength(1);
		expect(rows(auditEvents).filter((row) => row.eventType === "recipient.completed")).toHaveLength(
			1,
		);
		expect(
			rows(agenticSecurityEvents).filter((row) => row.eventType === "agentic.partner.completed"),
		).toHaveLength(1);

		const creatorPdf = await apiHono.request(
			`/api/v1/documents/${documentId}/pdf`,
			{
				headers: agentHeaders(creatorToken),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		const partnerPdf = await apiHono.request(
			`/api/v1/documents/${documentId}/pdf`,
			{
				headers: agentHeaders(partnerToken),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(creatorPdf.status).toBe(200);
		expect(partnerPdf.status).toBe(200);
		expect(new Uint8Array(await partnerPdf.arrayBuffer())).toEqual(
			new Uint8Array(await creatorPdf.arrayBuffer()),
		);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(JSON.stringify(rows(agenticSecurityEvents))).not.toContain(partnerToken);
		expect(JSON.stringify(rows(agenticSecurityEvents))).not.toContain(processToken);
	});

	it("returns stable partner authorization and lifecycle errors", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const { documentId } = await createSentTwoPartyFixture({
			keyPrefix: "partner-errors",
			fetchMock,
		});
		const task = (token = partnerToken) =>
			apiHono.request(`/api/v1/documents/${documentId}/signing-task`, {
				headers: agentHeaders(token),
			});
		const outsider = await task(outsiderToken);
		expect(outsider.status).toBe(403);
		await expect(outsider.json()).resolves.toEqual({
			error: expect.objectContaining({
				code: "AGENT_SIGNING_WRONG_IDENTITY",
				recoveryUrl: "/api/v1/documents",
			}),
		});
		const creatorOnly = await task(creatorToken);
		expect(creatorOnly.status).toBe(403);

		const envelope = rows(envelopes)[0];
		const recipient = rows(envelopeRecipients).find((row) => row.email === "partner@example.com");
		if (!envelope || !recipient) throw new Error("Partner error fixture missing rows");
		for (const [status, code, responseStatus] of [
			["draft", "AGENT_SIGNING_INACTIVE", 409],
			["changes_requested", "AGENT_SIGNING_CHANGES_REQUESTED", 409],
			["declined", "AGENT_SIGNING_DECLINED", 410],
			["expired", "AGENT_SIGNING_EXPIRED", 410],
			["deleted", "AGENT_SIGNING_DELETED", 410],
		] as const) {
			envelope.status = status;
			const response = await task();
			expect(response.status).toBe(responseStatus);
			await expect(response.json()).resolves.toEqual({
				error: expect.objectContaining({ code, retryable: false, recoveryUrl: expect.any(String) }),
			});
		}
		envelope.status = "completed";
		recipient.status = "completed";
		const completed = await task();
		expect(completed.status).toBe(409);
		await expect(completed.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "AGENT_SIGNING_COMPLETED" }),
		});

		const missing = await apiHono.request(
			"/api/v1/documents/90000000-0000-4000-8000-000000000099/signing-task",
			{ headers: agentHeaders(partnerToken) },
		);
		expect(missing.status).toBe(404);
		await expect(missing.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "AGENT_SIGNING_TASK_NOT_FOUND" }),
		});

		const partnerTokenRow = rows(agenticApiTokens).find(
			(row) => row.email === "PARTNER@Example.COM",
		);
		if (!partnerTokenRow) throw new Error("Partner token fixture missing");
		partnerTokenRow.status = "revoked";
		const revoked = await task();
		expect(revoked.status).toBe(401);
		await expect(revoked.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "AGENTIC_TOKEN_REQUIRED" }),
		});
	});
});
