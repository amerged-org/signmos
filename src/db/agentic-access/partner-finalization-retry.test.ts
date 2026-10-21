import { envelopeRecipients, envelopes } from "@/db/envelope";
import { apiHono } from "@/hono/api";
import {
	agentHeaders,
	createSentTwoPartyFixture,
	partnerToken,
	resetAgentPartnerFixture,
} from "@/hono/api/agent-partner-test-fixture";
import { selfSignRows as rows } from "@/hono/api/agent-self-sign-test-db";
import { authenticateAgenticBearer } from "./bearer-principal";
import { authorizeAgentPartnerSigning } from "./partner-signing";

vi.mock("@/db/setup", async () => {
	const { getAgentSelfSignTestDb } = await import("@/hono/api/agent-self-sign-test-db");
	return { getDb: getAgentSelfSignTestDb };
});

describe("partner finalization retry authority", () => {
	beforeEach(resetAgentPartnerFixture);
	afterEach(() => vi.restoreAllMocks());

	it("permits completion recovery only while sent and all signatures are recorded", async () => {
		const { documentId, partnerId } = await createSentTwoPartyFixture({
			keyPrefix: "finalization-retry-authority",
			fetchMock: vi.spyOn(globalThis, "fetch"),
		});
		const principal = await authenticateAgenticBearer({ authorization: `Bearer ${partnerToken}` });
		if (!principal) throw new Error("Missing partner fixture principal");
		const partner = rows(envelopeRecipients).find((row) => row.id === partnerId);
		const envelope = rows(envelopes).find((row) => row.id === documentId);
		if (!partner || !envelope) throw new Error("Missing signing fixture");
		partner.status = "completed";
		expect((await authorizeAgentPartnerSigning(principal, documentId)).state).toBe("completed");
		expect(
			(await authorizeAgentPartnerSigning(principal, documentId, { allowCompletionRetry: true }))
				.state,
		).toBe("active");
		const task = await apiHono.request(`/api/v1/documents/${documentId}/signing-task`, {
			headers: agentHeaders(partnerToken),
		});
		expect(task.status).toBe(200);
		const decline = await apiHono.request(`/api/v1/documents/${documentId}/decline`, {
			method: "POST",
			headers: agentHeaders(partnerToken, "decline-after-recorded-signature"),
			body: JSON.stringify({ reason: "Cannot replace a recorded signature" }),
		});
		expect(decline.status).toBe(409);
		const creator = rows(envelopeRecipients).find(
			(row) => row.id !== partnerId && row.envelopeId === documentId,
		);
		if (!creator) throw new Error("Missing creator fixture");
		creator.status = "sent";
		expect(
			(await authorizeAgentPartnerSigning(principal, documentId, { allowCompletionRetry: true }))
				.state,
		).toBe("completed");
		creator.status = "completed";
		envelope.status = "completed";
		expect(
			(await authorizeAgentPartnerSigning(principal, documentId, { allowCompletionRetry: true }))
				.state,
		).toBe("completed");
		envelope.status = "sent";
		expect(
			(
				await authorizeAgentPartnerSigning(
					{ ...principal, email: "outsider@example.com" },
					documentId,
					{ allowCompletionRetry: true },
				)
			).state,
		).toBe("wrong_identity");
	});
});
