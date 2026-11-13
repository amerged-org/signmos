import { z } from "zod";
import { MultipartContractSchema } from "@/omh/contracts-multipart";
import { CreateContractSchema } from "@/omh/contracts-schema";

const security = [{ bearerAuth: [] }];
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const summary = {
	type: "object",
	required: ["id", "title", "status", "recipients", "createdAt", "completedAt", "downloadUrl"],
	properties: {
		id: { type: "string", format: "uuid" },
		title: { type: "string" },
		status: { type: "string" },
		recipients: {
			type: "array",
			items: {
				type: "object",
				required: ["name", "email", "status"],
				properties: {
					name: { type: "string" },
					email: { type: "string", format: "email" },
					status: { type: "string" },
				},
			},
		},
		createdAt: { type: "string", format: "date-time" },
		completedAt: { type: ["string", "null"], format: "date-time" },
		downloadUrl: { type: ["string", "null"] },
	},
};
const data = (schema: unknown) => ({
	type: "object",
	required: ["data"],
	properties: { data: schema },
});
const response = (description: string, schema: unknown) => ({
	description,
	content: { "application/json": { schema } },
});
const errors = Object.fromEntries(
	[400, 403, 409, 413, 502, 503].map((code) => [
		String(code),
		{ description: "Request rejected or service unavailable" },
	]),
);
export function buildContractsPaths() {
	return {
		"/api/contracts": {
			get: {
				operationId: "listContracts",
				summary: "List owned contracts",
				security,
				responses: {
					"200": response("Owned contracts", data({ type: "array", items: summary })),
					...errors,
				},
			},
			post: {
				operationId: "createContract",
				summary: "Create and send a contract",
				security,
				parameters: [
					{
						name: "Idempotency-Key",
						in: "header",
						required: true,
						schema: { type: "string", minLength: 1, maxLength: 200 },
					},
				],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: z.toJSONSchema(CreateContractSchema, { io: "input" }) },
						"multipart/form-data": {
							schema: {
								type: "object",
								required: ["pdf", "definition"],
								properties: {
									pdf: { type: "string", format: "binary" },
									definition: z.toJSONSchema(MultipartContractSchema, { io: "input" }),
								},
							},
							encoding: {
								pdf: { contentType: "application/pdf" },
								definition: { contentType: "application/json" },
							},
						},
					},
				},
				responses: {
					"201": response("Created and sent (legacy JSON)", data(summary)),
					"202": response("Accepted and queued (multipart)", data(summary)),
					...errors,
				},
			},
		},
		"/api/contracts/{id}": {
			get: {
				operationId: "getContract",
				summary: "Get owned contract and recipient progress",
				security,
				parameters: [id],
				responses: {
					"200": response("Contract", data(summary)),
					"404": { description: "Not found" },
					...errors,
				},
			},
		},
		"/api/contracts/{id}/retry-invitations": {
			post: {
				operationId: "retryContractInvitations",
				summary: "Requeue invitations after an uncertain delivery",
				security,
				parameters: [
					id,
					{
						name: "Idempotency-Key",
						in: "header",
						required: true,
						schema: { type: "string", minLength: 1, maxLength: 200 },
					},
				],
				responses: {
					"200": response(
						"Retry result",
						data({
							type: "object",
							required: ["requeued", "manualReview"],
							properties: { requeued: { type: "integer" }, manualReview: { type: "integer" } },
						}),
					),
					"404": { description: "Not found" },
					...errors,
				},
			},
		},
		"/api/contracts/{id}/pdf": {
			get: {
				operationId: "downloadContractPdf",
				summary: "Download a completed PDF",
				security,
				parameters: [id],
				responses: {
					"200": {
						description: "Completed PDF",
						content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
					},
					"404": { description: "Not found" },
					...errors,
				},
			},
		},
	};
}
