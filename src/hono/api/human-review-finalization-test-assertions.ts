import { envelopes, fieldValues, finalDocuments } from "@/db/envelope";
import { apiHono } from "@/hono/api";
import { selfSignRows as rows, agentSelfSignTestState as state } from "./agent-self-sign-test-db";

export async function expectFinalizationRetryRecovery(input: {
	documentId: string;
	bucket: R2Bucket;
	completionPayload: unknown;
	agentHeaders: (key?: string) => Record<string, string>;
	approveReview: (
		command: { data: { reviewUrl: string } },
		now: Date,
		env: Partial<Env>,
	) => Response | Promise<Response>;
}): Promise<void> {
	expect(rows(envelopes).find((row) => row.id === input.documentId)?.status).toBe("sent");
	const recordedValues = rows(fieldValues).map((row) => ({ ...row }));
	expect(recordedValues).toHaveLength(2);
	const retry = await apiHono.request(`/api/v1/documents/${input.documentId}/complete`, {
		method: "POST",
		headers: input.agentHeaders("human-review-finalization-retry"),
		body: JSON.stringify(input.completionPayload),
	});
	expect(retry.status).toBe(202);
	const command = (await retry.json()) as { data: { reviewUrl: string; statusUrl: string } };
	const approved = await input.approveReview(command, state.now, {
		DOCUMENTS_BUCKET: input.bucket,
	});
	expect(approved.status).toBe(200);
	await expect(approved.json()).resolves.toMatchObject({
		data: { status: "completed", result: { envelopeStatus: "completed" } },
	});
	expect(rows(fieldValues)).toEqual(recordedValues);
	expect(rows(finalDocuments)).toHaveLength(1);
	expect(rows(envelopes).find((row) => row.id === input.documentId)?.status).toBe("completed");
}
