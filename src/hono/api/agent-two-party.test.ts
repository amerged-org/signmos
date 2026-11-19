import { agenticApiTokens, agenticSecurityEvents } from "@/db/agentic-access";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { emailSendRecords, envelopeFields, envelopeRecipients, envelopes } from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { pdfFixtureText } from "@/test/pdf-fixtures";
import {
	agentSelfSignBucket,
	agentSelfSignTables,
	selfSignRows as rows,
	agentSelfSignTestState as state,
} from "./agent-self-sign-test-db";

const rawToken = "signmos_agent_two_party_creator";

vi.mock("@/db/setup", async () => {
	const { getAgentSelfSignTestDb } = await import("./agent-self-sign-test-db");
	return { getDb: getAgentSelfSignTestDb };
});

function commandHeaders(key: string, contentType = "application/json") {
	return {
		authorization: `Bearer ${rawToken}`,
		"content-type": contentType,
		"idempotency-key": key,
		"x-now": state.now.toISOString(),
	};
}

async function createTwoPartyDraft(key: string): Promise<string> {
	const response = await apiHono.request("/api/v1/documents", {
		method: "POST",
		headers: commandHeaders(key),
		body: JSON.stringify({ name: "Grace Creator", signingMode: "me_and_another_signer" }),
	});
	return ((await response.json()) as { data: { documentId: string } }).data.documentId;
}

describe("agent two-party creator", () => {
	beforeEach(async () => {
		state.rows = new Map(agentSelfSignTables.map((table) => [table, []]));
		state.r2Objects.clear();
		state.r2PutCounts.clear();
		state.now = new Date("2026-07-17T12:00:00.000Z");
		rows(agenticApiTokens).push({
			id: "a0000000-0000-4000-8000-000000000001",
			email: "creator@example.com",
			name: "Creator automation",
			tokenHash: await hashAgenticCredential(rawToken),
			tokenHint: "signmos_...ator",
			status: "active",
			activeSlot: 1,
			lastUsedAt: null,
			revokedAt: null,
			createdAt: new Date("2026-07-17T08:00:00.000Z"),
		});
	});

	it("creates a normalized two-party draft without another verification delivery", async () => {
		const response = await apiHono.request("/api/v1/documents", {
			method: "POST",
			headers: commandHeaders("two-party-create"),
			body: JSON.stringify({
				name: "Grace Creator",
				signingMode: "me_and_another_signer",
			}),
		});

		expect(response.status).toBe(201);
		const body = (await response.json()) as { data: { documentId: string } };
		expect(rows(envelopes)).toEqual([
			expect.objectContaining({
				id: body.data.documentId,
				createdBy: "creator@example.com",
				createdByName: "Grace Creator",
				signingMode: "me_and_another_signer",
				status: "draft",
			}),
		]);
		expect(rows(envelopeRecipients)).toEqual([
			expect.objectContaining({
				envelopeId: body.data.documentId,
				email: "creator@example.com",
				status: "pending",
			}),
		]);
		expect(rows(emailSendRecords)).toHaveLength(0);
		expect(rows(agenticSecurityEvents)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					documentId: body.data.documentId,
					email: "creator@example.com",
					eventType: "agentic.document.created",
				}),
			]),
		);
	});

	it("agent command idempotency manages normalized recipients through the 10-recipient bound", async () => {
		const documentId = await createTwoPartyDraft("recipient-create");
		const added = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
			method: "POST",
			headers: commandHeaders("recipient-add"),
			body: JSON.stringify({
				recipients: [{ name: "Ada Partner", email: "  PARTNER@Example.COM " }],
			}),
		});
		expect(added.status).toBe(201);
		const addedBody = (await added.json()) as { data: Array<{ id: string; email: string }> };
		expect(addedBody.data[0]?.email).toBe("partner@example.com");
		const partnerId = addedBody.data[0]?.id;
		expect(partnerId).toBeTruthy();

		const replay = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
			method: "POST",
			headers: commandHeaders("recipient-add"),
			body: JSON.stringify({
				recipients: [{ name: "Ada Partner", email: "  PARTNER@Example.COM " }],
			}),
		});
		expect(replay.status).toBe(201);
		await expect(replay.json()).resolves.toEqual(addedBody);

		const duplicate = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
			method: "POST",
			headers: commandHeaders("recipient-duplicate"),
			body: JSON.stringify({
				recipients: [{ name: "Duplicate", email: "partner@example.com" }],
			}),
		});
		expect(duplicate.status).toBe(409);
		await expect(duplicate.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "DUPLICATE_RECIPIENT" }),
		});

		const listed = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
			headers: commandHeaders("unused-list"),
		});
		expect(listed.status).toBe(200);
		await expect(listed.json()).resolves.toEqual({
			data: expect.arrayContaining([
				expect.objectContaining({ email: "creator@example.com" }),
				expect.objectContaining({ email: "partner@example.com" }),
			]),
		});

		const updated = await apiHono.request(
			`/api/v1/documents/${documentId}/recipients/${partnerId}`,
			{
				method: "PATCH",
				headers: commandHeaders("recipient-update"),
				body: JSON.stringify({ name: "Ada Updated", email: "UPDATED@example.com" }),
			},
		);
		expect(updated.status).toBe(200);
		const updatedBody = await updated.json();
		expect(updatedBody).toEqual({
			data: expect.objectContaining({ name: "Ada Updated", email: "updated@example.com" }),
		});
		const updateReplay = await apiHono.request(
			`/api/v1/documents/${documentId}/recipients/${partnerId}`,
			{
				method: "PATCH",
				headers: commandHeaders("recipient-update"),
				body: JSON.stringify({ name: "Ada Updated", email: "UPDATED@example.com" }),
			},
		);
		expect(updateReplay.status).toBe(200);
		await expect(updateReplay.json()).resolves.toEqual(updatedBody);

		const deleted = await apiHono.request(
			`/api/v1/documents/${documentId}/recipients/${partnerId}`,
			{ method: "DELETE", headers: commandHeaders("recipient-delete") },
		);
		expect(deleted.status).toBe(200);
		const deletedBody = await deleted.json();
		expect(rows(envelopeRecipients)).toHaveLength(1);
		const deleteReplay = await apiHono.request(
			`/api/v1/documents/${documentId}/recipients/${partnerId}`,
			{ method: "DELETE", headers: commandHeaders("recipient-delete") },
		);
		expect(deleteReplay.status).toBe(200);
		await expect(deleteReplay.json()).resolves.toEqual(deletedBody);
		expect(rows(envelopeRecipients)).toHaveLength(1);

		const boundaryRecipients = Array.from({ length: 9 }, (_, index) => ({
			name: `Partner ${index + 1}`,
			email: `partner-${index + 1}@example.com`,
		}));
		const boundary = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
			method: "POST",
			headers: commandHeaders("recipient-boundary"),
			body: JSON.stringify({ recipients: boundaryRecipients }),
		});
		expect(boundary.status).toBe(201);
		expect(rows(envelopeRecipients)).toHaveLength(10);
		const overLimit = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
			method: "POST",
			headers: commandHeaders("recipient-over-limit"),
			body: JSON.stringify({ recipients: [{ name: "Eleventh", email: "eleven@example.com" }] }),
		});
		expect(overLimit.status).toBe(409);
		await expect(overLimit.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "RECIPIENT_LIMIT_REACHED", limit: 10 }),
		});
	});

	it("places and lists creator/partner fields with existing assignment constraints", async () => {
		const bucket = agentSelfSignBucket();
		const documentId = await createTwoPartyDraft("fields-create");
		const uploaded = await apiHono.request(
			`/api/v1/documents/${documentId}/source-pdf`,
			{
				method: "PUT",
				headers: commandHeaders("fields-upload", "application/pdf"),
				body: pdfFixtureText("two party fields"),
			},
			{ DOCUMENTS_BUCKET: bucket },
		);
		expect(uploaded.status).toBe(201);
		const added = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
			method: "POST",
			headers: commandHeaders("fields-recipient"),
			body: JSON.stringify({
				recipients: [{ name: "Ada Partner", email: "partner@example.com" }],
			}),
		});
		const partnerId = ((await added.json()) as { data: Array<{ id: string }> }).data[0]?.id;
		const creatorId = rows(envelopeRecipients).find(
			(recipient) => recipient.email === "creator@example.com",
		)?.id;
		expect(creatorId).toBeTruthy();
		expect(partnerId).toBeTruthy();
		const invalidRecipient = await apiHono.request(`/api/v1/documents/${documentId}/fields`, {
			method: "POST",
			headers: commandHeaders("fields-invalid-recipient"),
			body: JSON.stringify({
				fields: [
					{
						recipientId: "90000000-0000-4000-8000-000000000099",
						type: "date",
						page: 1,
						x: 40,
						y: 40,
						width: 120,
						height: 32,
					},
				],
			}),
		});
		expect(invalidRecipient.status).toBe(400);
		await expect(invalidRecipient.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "INVALID_FIELDS", fields: ["fields"] }),
		});

		const placed = await apiHono.request(`/api/v1/documents/${documentId}/fields`, {
			method: "POST",
			headers: commandHeaders("fields-explicit"),
			body: JSON.stringify({
				fields: [
					{
						recipientId: creatorId,
						type: "signature",
						page: 1,
						x: 40,
						y: 80,
						width: 180,
						height: 48,
					},
					{
						recipientId: partnerId,
						type: "signature",
						page: 1,
						x: 320,
						y: 80,
						width: 180,
						height: 48,
					},
				],
			}),
		});
		expect(placed.status).toBe(201);
		await expect(placed.json()).resolves.toEqual({
			data: expect.objectContaining({ status: "draft", fields: expect.any(Array) }),
		});
		expect(rows(envelopeFields)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ recipientId: creatorId, type: "signature", x: 40 }),
				expect.objectContaining({ recipientId: partnerId, type: "signature", x: 320 }),
			]),
		);
		const partnerFieldId = String(
			rows(envelopeFields).find((field) => field.recipientId === partnerId)?.id,
		);
		const partnerReposition = await apiHono.request(
			`/api/v1/documents/${documentId}/fields/${partnerFieldId}`,
			{
				method: "PATCH",
				headers: commandHeaders("fields-partner-reposition"),
				body: JSON.stringify({ page: 1, x: 300, y: 200 }),
			},
		);
		expect(partnerReposition.status).toBe(404);
		await expect(partnerReposition.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "AGENT_SIGNING_TASK_NOT_FOUND" }),
		});

		const listed = await apiHono.request(`/api/v1/documents/${documentId}/fields`, {
			headers: commandHeaders("unused-field-list"),
		});
		expect(listed.status).toBe(200);
		await expect(listed.json()).resolves.toEqual({ data: expect.any(Array) });

		const duplicate = await apiHono.request(`/api/v1/documents/${documentId}/fields`, {
			method: "POST",
			headers: commandHeaders("fields-duplicate"),
			body: JSON.stringify({
				fields: [
					{
						recipientId: partnerId,
						type: "signature",
						page: 1,
						x: 320,
						y: 180,
						width: 180,
						height: 48,
					},
				],
			}),
		});
		expect(duplicate.status).toBe(409);
		await expect(duplicate.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "SIGNATURE_PLACEHOLDER_LIMIT" }),
		});
	});

	it("agent command idempotency rejects changed-key, outsider, locked, and non-draft intent", async () => {
		const documentId = await createTwoPartyDraft("authorization-create");
		const invalid = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
			method: "POST",
			headers: commandHeaders("authorization-invalid"),
			body: JSON.stringify({ recipients: [{ name: "Bad", email: "not-an-email" }] }),
		});
		expect(invalid.status).toBe(400);
		await expect(invalid.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "INVALID_RECIPIENTS", fields: ["recipients"] }),
		});

		const addRequest = (email: string, token = rawToken) =>
			apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
				method: "POST",
				headers: { ...commandHeaders("authorization-add"), authorization: `Bearer ${token}` },
				body: JSON.stringify({ recipients: [{ name: "Partner", email }] }),
			});
		const added = await addRequest("partner@example.com");
		expect(added.status).toBe(201);
		const partnerId = ((await added.json()) as { data: Array<{ id: string }> }).data[0]?.id;
		const changedKey = await addRequest("changed@example.com");
		expect(changedKey.status).toBe(409);
		await expect(changedKey.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
		});

		const creatorId = String(
			rows(envelopeRecipients).find((recipient) => recipient.email === "creator@example.com")?.id,
		);
		const creatorLocked = await apiHono.request(
			`/api/v1/documents/${documentId}/recipients/${creatorId}`,
			{
				method: "PATCH",
				headers: commandHeaders("authorization-creator-locked"),
				body: JSON.stringify({ name: "Changed", email: "changed-creator@example.com" }),
			},
		);
		expect(creatorLocked.status).toBe(409);
		await expect(creatorLocked.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "CREATOR_RECIPIENT_LOCKED" }),
		});

		const outsiderToken = "signmos_agent_two_party_outsider";
		rows(agenticApiTokens).push({
			id: "a0000000-0000-4000-8000-000000000002",
			email: "outsider@example.com",
			name: "Outsider",
			tokenHash: await hashAgenticCredential(outsiderToken),
			tokenHint: "signmos_...ider",
			status: "active",
			activeSlot: 1,
			lastUsedAt: null,
			revokedAt: null,
			createdAt: state.now,
		});
		const outsider = await apiHono.request(`/api/v1/documents/${documentId}/recipients`, {
			headers: { authorization: `Bearer ${outsiderToken}` },
		});
		expect(outsider.status).toBe(404);

		Object.assign(rows(envelopes)[0] ?? {}, { status: "sent" });
		const nonDraft = await apiHono.request(
			`/api/v1/documents/${documentId}/recipients/${partnerId}`,
			{
				method: "PATCH",
				headers: commandHeaders("authorization-non-draft"),
				body: JSON.stringify({ name: "Blocked", email: "blocked@example.com" }),
			},
		);
		expect(nonDraft.status).toBe(409);
		await expect(nonDraft.json()).resolves.toEqual({
			error: expect.objectContaining({ code: "ENVELOPE_NOT_DRAFT" }),
		});
	});
});
