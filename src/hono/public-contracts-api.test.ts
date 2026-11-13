import { publicAgentContractHono } from "./public-agent-contract";

it("publishes the multipart contract and invitation recovery endpoints", async () => {
	const response = await publicAgentContractHono.request("/openapi.json");
	expect(response.status).toBe(200);
	const document = (await response.json()) as {
		paths: Record<
			string,
			Record<
				string,
				{
					security: unknown;
					parameters?: Array<{ name: string }>;
					requestBody?: { content: Record<string, unknown> };
					responses: Record<string, unknown>;
				}
			>
		>;
	};
	const create = document.paths["/api/contracts"]?.post;
	expect(create?.security).toEqual([{ bearerAuth: [] }]);
	expect(create?.parameters).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "Idempotency-Key" })]),
	);
	expect(create?.requestBody?.content).toHaveProperty("multipart/form-data");
	expect(create?.requestBody?.content).toHaveProperty("application/json");
	expect(create?.responses).toHaveProperty("202");
	expect(document.paths["/api/contracts/{id}/retry-invitations"]?.post?.parameters).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "Idempotency-Key" })]),
	);
});
