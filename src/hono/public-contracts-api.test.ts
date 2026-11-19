import { z } from "zod";
import { VerifySignerEmailCodeSchema } from "@/db/signer-email/schema";
import {
	DraftContractJsonSchema,
	PatchContractSchema,
	SendContractSchema,
} from "@/omh/contracts-draft-schema";
import { MultipartContractSchema } from "@/omh/contracts-multipart";
import { CreateContractSchema } from "@/omh/contracts-schema";
import { publicAgentContractHono } from "./public-agent-contract";

interface Operation {
	operationId: string;
	description?: string;
	security: unknown;
	parameters?: Array<{ name: string; required: boolean }>;
	requestBody?: { required: boolean; content: Record<string, { schema: unknown }> };
	responses: Record<
		string,
		{ content?: Record<string, { schema: unknown }>; headers?: Record<string, unknown> }
	>;
}
type Document = { paths: Record<string, Record<string, Operation>> };
async function openapi(): Promise<Document> {
	const response = await publicAgentContractHono.request("/openapi.json");
	expect(response.status).toBe(200);
	return response.json();
}
function input(operation: Operation, media = "application/json") {
	return operation.requestBody?.content[media]?.schema;
}
function output(operation: Operation, status = "200") {
	return operation.responses[status]?.content?.["application/json"]?.schema;
}

it("documents pending private erasure and its absolute retry deadline", async () => {
	const { paths } = await openapi();
	const operation = paths["/api/contracts/{id}"].delete;
	expect(output(operation, "503")).toMatchObject({
		properties: {
			error: {
				properties: {
					retryAt: { type: "string", format: "date-time" },
					retryable: { type: "boolean" },
				},
			},
		},
	});
	expect(operation.responses["503"].headers).toMatchObject({
		"Retry-After": { schema: { type: "string" } },
	});
});

it("retains both existing create-and-send formats and invitation recovery", async () => {
	const { paths } = await openapi();
	const create = paths["/api/contracts"].post;
	expect(input(create)).toEqual(z.toJSONSchema(CreateContractSchema, { io: "input" }));
	expect(input(create, "multipart/form-data")).toMatchObject({
		oneOf: [{ required: ["pdf", "definition"] }, { required: ["html", "definition"] }],
	});
	expect(create.responses).toHaveProperty("201");
	expect(create.responses).toHaveProperty("202");
	expect(paths["/api/contracts/{id}/retry-invitations"].post.responses).toHaveProperty("200");
	expect(paths["/api/contracts/{id}/pdf"].get.responses["200"].content).toHaveProperty(
		"application/pdf",
	);
});

it("requires administrator authority and idempotency for every contract mutation", async () => {
	const { paths } = await openapi();
	for (const [path, method] of [
		["/api/contracts", "post"],
		["/api/contracts/drafts", "post"],
		["/api/contracts/{id}", "patch"],
		["/api/contracts/{id}", "delete"],
		["/api/contracts/{id}/pdf", "put"],
		["/api/contracts/{id}/send", "post"],
		["/api/contracts/{id}/cancel", "post"],
		["/api/contracts/{id}/retry-invitations", "post"],
	]) {
		const operation = paths[path][method];
		expect(operation.security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
		expect(operation.parameters).toContainEqual(
			expect.objectContaining({ name: "Idempotency-Key", required: true }),
		);
		expect(operation.responses).toHaveProperty("403");
		expect(operation.responses).toHaveProperty("404");
		expect(operation.responses).toHaveProperty("409");
	}
});

it("publishes draft create, replacement, patch and send schemas from runtime validators", async () => {
	const { paths } = await openapi();
	const draft = paths["/api/contracts/drafts"].post;
	const replacement = paths["/api/contracts/{id}/pdf"].put;
	for (const operation of [draft, replacement]) {
		expect(input(operation)).toEqual(z.toJSONSchema(DraftContractJsonSchema, { io: "input" }));
		expect(Object.keys(operation.requestBody?.content ?? {}).sort()).toEqual([
			"application/json",
			"multipart/form-data",
		]);
	}
	const pdf = {
		required: ["pdf", "definition"],
		properties: { definition: z.toJSONSchema(MultipartContractSchema, { io: "input" }) },
	};
	expect(input(replacement, "multipart/form-data")).toMatchObject(pdf);
	expect(input(draft, "multipart/form-data")).toMatchObject({
		oneOf: [pdf, { ...pdf, required: ["html", "definition"] }],
	});
	expect(input(paths["/api/contracts/{id}"].patch)).toEqual(
		z.toJSONSchema(PatchContractSchema, { io: "input" }),
	);
	expect(input(paths["/api/contracts/{id}/send"].post)).toEqual(
		z.toJSONSchema(SendContractSchema, { io: "input" }),
	);
	expect(paths["/api/contracts/{id}/cancel"].post.requestBody?.required).toBe(false);
});

it("exposes personal links only in owned send receipts and keeps draft metadata PDF-free", async () => {
	const { paths } = await openapi();
	const send = paths["/api/contracts/{id}/send"].post;
	for (const status of ["200", "202"]) {
		expect(output(send, status)).toMatchObject({
			properties: {
				data: {
					required: expect.arrayContaining(["signingLinks"]),
					properties: {
						signingLinks: { items: { required: ["recipientId", "email", "url", "expiresAt"] } },
					},
				},
			},
		});
	}
	for (const operation of [
		paths["/api/contracts"].get,
		paths["/api/contracts/{id}"].get,
		paths["/api/contracts"].post,
	]) {
		expect(JSON.stringify(operation.responses)).not.toContain('"signingLinks"');
		expect(JSON.stringify(operation.responses)).not.toContain('"base64"');
	}
	expect(output(paths["/api/contracts/{id}"].get)).toMatchObject({
		properties: { data: { properties: { definition: expect.any(Object) } } },
	});
	expect(output(paths["/api/contracts/{id}"].delete)).toMatchObject({
		properties: { data: { properties: { status: { const: "deleted" } } } },
	});
	expect(output(paths["/api/contracts/{id}/cancel"].post)).toMatchObject({
		properties: { data: { properties: { status: { const: "expired" } } } },
	});
});

it("documents mandatory recipient email proof without requiring administrator credentials", async () => {
	const { paths } = await openapi();
	const inspect = paths["/api/signing/verifications/{token}"].get;
	const request = paths["/api/signing/{token}/email-code/request"].post;
	const verify = paths["/api/signing/{token}/email-code/verify"].post;
	for (const operation of [inspect, request, verify]) {
		expect(operation.security).toEqual([]);
		expect(operation.parameters?.map((parameter) => parameter.name)).toEqual(["token"]);
	}
	expect(output(inspect)).toMatchObject({
		properties: { data: { properties: { status: { const: "email_verification_required" } } } },
	});
	expect(output(request)).toMatchObject({
		properties: { data: { required: ["emailHint", "expiresInSeconds", "retryAfterSeconds"] } },
	});
	expect(JSON.stringify(output(request))).not.toContain('"code"');
	expect(request.responses["429"].headers).toHaveProperty("Retry-After");
	expect(input(verify)).toMatchObject({
		required: ["code"],
		properties: { code: { type: "string", pattern: "^\\d{6}$" } },
	});
	expect(input(verify)).toEqual(z.toJSONSchema(VerifySignerEmailCodeSchema, { io: "input" }));
	expect(request.requestBody?.required).toBe(false);
	expect(verify.responses["200"].headers).toHaveProperty("Set-Cookie");
	expect(verify.description).toContain("including final links");
});
