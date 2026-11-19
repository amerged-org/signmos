import { MAX_DOCUMENT_FIELDS, MAX_SOURCE_PDF_PAGES } from "@/db/envelope/pdf-policy-limits";
import { AddFieldsRequestSchema, DefaultFieldPlacementRequestSchema } from "@/db/envelope/schema";
import { publicAgentContractHono } from "@/hono/public-agent-contract";
import {
	AgentDocumentErrorCodeSchema,
	AgentSelfSignDefaultFieldsRequestSchema,
	AgentSelfSignFieldPlacementRequestSchema,
	AgentSelfSignFieldsRequestSchema,
} from "./schema";

describe("PDF policy at the Agent API boundary", () => {
	const recipientId = "f0000000-0000-4000-8000-000000000001";
	const field = {
		recipientId,
		type: "date",
		page: MAX_SOURCE_PDF_PAGES,
		x: 10,
		y: 10,
		width: 80,
		height: 25,
	};

	it("accepts exact page and field bounds and rejects values above both request boundaries", () => {
		for (const schema of [AddFieldsRequestSchema, AgentSelfSignFieldsRequestSchema]) {
			expect(
				schema.safeParse({ fields: Array.from({ length: MAX_DOCUMENT_FIELDS }, () => field) })
					.success,
			).toBe(true);
			expect(
				schema.safeParse({ fields: Array.from({ length: MAX_DOCUMENT_FIELDS + 1 }, () => field) })
					.success,
			).toBe(false);
			expect(
				schema.safeParse({ fields: [{ ...field, page: MAX_SOURCE_PDF_PAGES + 1 }] }).success,
			).toBe(false);
		}
		for (const schema of [
			DefaultFieldPlacementRequestSchema,
			AgentSelfSignDefaultFieldsRequestSchema,
		]) {
			expect(
				schema.safeParse({ recipientIds: [recipientId], page: MAX_SOURCE_PDF_PAGES }).success,
			).toBe(true);
			expect(
				schema.safeParse({ recipientIds: [recipientId], page: MAX_SOURCE_PDF_PAGES + 1 }).success,
			).toBe(false);
		}
		expect(
			AgentSelfSignFieldPlacementRequestSchema.safeParse({
				page: MAX_SOURCE_PDF_PAGES + 1,
				x: 10,
				y: 10,
			}).success,
		).toBe(false);
	});

	it("publishes runtime policy limits and recovery codes in the generated contract", async () => {
		for (const code of [
			"SOURCE_PDF_TOO_MANY_PAGES",
			"SOURCE_PDF_TOO_MANY_FIELDS",
			"FINAL_PDF_GENERATION_FAILED",
		])
			expect(AgentDocumentErrorCodeSchema.safeParse(code).success).toBe(true);
		const contract = await (await publicAgentContractHono.request("/openapi.json")).json();
		const serialized = JSON.stringify(contract);
		for (const code of [
			"SOURCE_PDF_TOO_MANY_PAGES",
			"SOURCE_PDF_TOO_MANY_FIELDS",
			"FINAL_PDF_GENERATION_FAILED",
		])
			expect(serialized).toContain(code);
		expect(serialized).toContain('"maxItems":20');
		expect(serialized).toContain('"maximum":10');
		const guidance = await (await publicAgentContractHono.request("/agent.md")).text();
		expect(guidance).toContain("2097152 bytes (2 MiB), 10 pages, and 20 signing fields");
		expect(guidance).toContain("Do not report completion");
	});
});
