import { z } from "zod";
import {
	HumanReviewCommandStatusResponseSchema,
	PendingHumanReviewCommandResponseSchema,
} from "@/db/agentic-access/human-review-schema";
import {
	AgentDocumentCatalogResponseSchema,
	AgentDocumentDetailResponseSchema,
	AgentDocumentHistoryResponseSchema,
	AgentDocumentStatusResponseSchema,
	AgentEmptyCommandRequestSchema,
	AgentFieldsResponseSchema,
	AgentRecipientCreateSchema,
	AgentRecipientResponseSchema,
	AgentRecipientsAddRequestSchema,
	AgentRecipientsResponseSchema,
	AgentSelfSignCompleteRequestSchema,
	AgentSelfSignCreateRequestSchema,
	AgentSelfSignCreateResponseSchema,
	AgentSelfSignDefaultFieldsRequestSchema,
	AgentSelfSignFieldPlacementRequestSchema,
	AgentSelfSignFieldPlacementResponseSchema,
	AgentSelfSignFieldsRequestSchema,
	AgentSelfSignFieldsResponseSchema,
	AgentSelfSignTaskResponseSchema,
	AgentSignatureProfileCreateRequestSchema,
	AgentSignatureProfileResponseSchema,
	AgentSourcePdfResponseSchema,
	AgentTwoPartyResendResponseSchema,
	AgentTwoPartySendResponseSchema,
	AgentV1MeResponseSchema,
} from "@/db/agentic-access/schema";
import { MAX_SOURCE_PDF_BYTES, MAX_SOURCE_PDF_PAGES } from "@/db/envelope/pdf-policy-limits";
import { publicAgentContractHono } from "@/hono/public-agent-contract";

describe("agentic onboarding public contract", () => {
	it("publishes secret-free guidance and OpenAPI from the runtime identity schema", async () => {
		// Issue #44 publication assumptions before RED:
		// - Both resources are public root paths and never inspect Authorization.
		// - The identity response schema is the exact Zod trust boundary used by the handler.
		// - Guidance references the environment variable, never a generated token value.
		const canary = "signmos_DO_NOT_PUBLISH_CANARY";
		const guidance = await publicAgentContractHono.request("/agent.md", {
			headers: { authorization: `Bearer ${canary}` },
		});
		expect(guidance.status).toBe(200);
		expect(guidance.headers.get("content-type")).toMatch(/^text\/markdown/);
		const markdown = await guidance.text();
		expect(markdown).toContain("/api/v1/me");
		expect(markdown).toContain("Authorization: Bearer");
		expect(markdown).toContain("$SIGNMOS_TOKEN");
		expect(markdown).not.toContain(canary);

		const openapiResponse = await publicAgentContractHono.request("/openapi.json", {
			headers: { authorization: `Bearer ${canary}` },
		});
		expect(openapiResponse.status).toBe(200);
		const document = (await openapiResponse.json()) as {
			openapi: string;
			paths: Record<string, unknown>;
		};
		expect(document.openapi).toBe("3.1.0");
		expect(document.paths).toEqual(
			expect.objectContaining({
				"/api/v1/me": {
					get: expect.objectContaining({
						operationId: "getAgentIdentity",
						security: [{ bearerAuth: [] }],
						responses: expect.objectContaining({
							"200": expect.objectContaining({
								content: {
									"application/json": {
										schema: z.toJSONSchema(AgentV1MeResponseSchema),
									},
								},
							}),
						}),
					}),
				},
			}),
		);
		expect(JSON.stringify(document)).not.toContain(canary);
	});

	it("agent API contract publishes read-only document discovery, inspection, and download", async () => {
		// Issue #46 contract assumptions before RED:
		// - Runtime Zod schemas remain the source for every JSON success/error projection.
		// - All document routes require Bearer authentication and expose no browser/process credentials.
		// - PDF is an application/pdf binary response; filters and machine recovery are explicit.
		const openapiResponse = await publicAgentContractHono.request("/openapi.json");
		const document = (await openapiResponse.json()) as {
			paths: Record<string, Record<string, unknown>>;
		};
		const expectedOperations = {
			"/api/v1/documents": "listAgentDocuments",
			"/api/v1/documents/{documentId}": "getAgentDocument",
			"/api/v1/documents/{documentId}/status": "getAgentDocumentStatus",
			"/api/v1/documents/{documentId}/history": "getAgentDocumentHistory",
			"/api/v1/documents/{documentId}/pdf": "downloadAgentFinalPdf",
		};
		for (const [path, operationId] of Object.entries(expectedOperations)) {
			const operation = document.paths[path]?.get as
				| { operationId?: string; security?: unknown }
				| undefined;
			expect(operation).toEqual(
				expect.objectContaining({
					operationId,
					security: [{ bearerAuth: [] }],
				}),
			);
		}
		for (const [path, schema] of [
			["/api/v1/documents", AgentDocumentCatalogResponseSchema],
			["/api/v1/documents/{documentId}", AgentDocumentDetailResponseSchema],
			["/api/v1/documents/{documentId}/status", AgentDocumentStatusResponseSchema],
			["/api/v1/documents/{documentId}/history", AgentDocumentHistoryResponseSchema],
		] as const) {
			const operation = document.paths[path]?.get as {
				responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
			};
			expect(operation.responses?.["200"]?.content?.["application/json"]?.schema).toEqual(
				z.toJSONSchema(schema),
			);
		}

		const catalog = document.paths["/api/v1/documents"]?.get as {
			parameters?: Array<{ name: string }>;
		};
		expect(catalog.parameters?.map((parameter) => parameter.name)).toEqual([
			"search",
			"role",
			"group",
			"status",
			"page",
		]);
		const serialized = JSON.stringify(document);
		expect(serialized).toContain('"application/pdf"');
		expect(serialized).toContain('"format":"binary"');
		expect(serialized).toContain("AGENT_DOCUMENT_NOT_FOUND");
		expect(serialized).toContain("AGENT_FINAL_PDF_UNAVAILABLE");
		expect(serialized).toContain("retryable");
		expect(serialized).not.toMatch(/senderSessionToken|signerToken|x-internal-user-id/);

		const guidance = await publicAgentContractHono.request("/agent.md");
		const markdown = await guidance.text();
		for (const phrase of [
			"Confirm identity",
			"Discover documents",
			"Creator, signer, and dual roles",
			"Poll document status",
			"Download a completed PDF",
			"Revoked, deleted, or unavailable",
		]) {
			expect(markdown).toContain(phrase);
		}
	});

	it("agent API contract publishes the complete idempotent self-sign workflow", async () => {
		// Issue #47 contract assumptions before RED:
		// - Every mutation is named here and requires one Idempotency-Key header.
		// - Preparation/source reads are Bearer-only but never expose process credentials.
		// - The public guide is sufficient to run create -> upload -> prepare -> sign -> download.
		const response = await publicAgentContractHono.request("/openapi.json");
		const document = (await response.json()) as {
			paths: Record<string, Record<string, unknown>>;
		};
		const operations = [
			["post", "/api/v1/documents", "createAgentSelfSignDocument", true],
			["put", "/api/v1/documents/{documentId}/source-pdf", "uploadAgentSourcePdf", true],
			["get", "/api/v1/documents/{documentId}/source-pdf", "getAgentSourcePdf", false],
			["get", "/api/v1/documents/{documentId}/source-pdf/content", "downloadAgentSourcePdf", false],
			[
				"post",
				"/api/v1/documents/{documentId}/signature-profiles",
				"createAgentSignatureProfile",
				true,
			],
			[
				"get",
				"/api/v1/documents/{documentId}/signature-profiles/selected",
				"getAgentSelectedSignatureProfile",
				false,
			],
			["post", "/api/v1/documents/{documentId}/fields", "placeAgentFields", true],
			["post", "/api/v1/documents/{documentId}/fields/defaults", "placeAgentDefaultFields", true],
			["get", "/api/v1/documents/{documentId}/signing-task", "getAgentSigningTask", false],
			[
				"patch",
				"/api/v1/documents/{documentId}/fields/{fieldId}",
				"repositionAgentSigningField",
				true,
			],
			["post", "/api/v1/documents/{documentId}/complete", "completeAgentSigning", true],
		] as const;

		for (const [method, path, operationId, mutates] of operations) {
			const operation = document.paths[path]?.[method] as
				| { operationId?: string; security?: unknown; parameters?: Array<{ name?: string }> }
				| undefined;
			expect(operation).toEqual(
				expect.objectContaining({ operationId, security: [{ bearerAuth: [] }] }),
			);
			if (mutates) {
				expect(operation?.parameters?.map((parameter) => parameter.name)).toContain(
					"Idempotency-Key",
				);
			}
		}
		const jsonContracts = [
			[
				"post",
				"/api/v1/documents",
				"201",
				AgentSelfSignCreateRequestSchema,
				AgentSelfSignCreateResponseSchema,
			],
			[
				"post",
				"/api/v1/documents/{documentId}/signature-profiles",
				"201",
				AgentSignatureProfileCreateRequestSchema,
				AgentSignatureProfileResponseSchema,
			],
			[
				"post",
				"/api/v1/documents/{documentId}/fields",
				"201",
				AgentSelfSignFieldsRequestSchema,
				AgentSelfSignFieldsResponseSchema,
			],
			[
				"post",
				"/api/v1/documents/{documentId}/fields/defaults",
				"201",
				AgentSelfSignDefaultFieldsRequestSchema,
				AgentSelfSignFieldsResponseSchema,
			],
			[
				"patch",
				"/api/v1/documents/{documentId}/fields/{fieldId}",
				"200",
				AgentSelfSignFieldPlacementRequestSchema,
				AgentSelfSignFieldPlacementResponseSchema,
			],
		] as const;
		for (const [method, path, status, requestSchema, responseSchema] of jsonContracts) {
			const operation = document.paths[path]?.[method] as {
				requestBody?: { content?: Record<string, { schema?: unknown }> };
				responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
			};
			expect(operation.requestBody?.content?.["application/json"]?.schema).toEqual(
				z.toJSONSchema(requestSchema),
			);
			expect(operation.responses?.[status]?.content?.["application/json"]?.schema).toEqual(
				z.toJSONSchema(responseSchema),
			);
		}
		const completion = document.paths["/api/v1/documents/{documentId}/complete"]?.post as {
			requestBody?: { content?: Record<string, { schema?: unknown }> };
			responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
		};
		expect(completion.requestBody?.content?.["application/json"]?.schema).toEqual(
			z.toJSONSchema(AgentSelfSignCompleteRequestSchema),
		);
		expect(completion.responses?.["202"]?.content?.["application/json"]?.schema).toEqual(
			z.toJSONSchema(PendingHumanReviewCommandResponseSchema),
		);
		expect(completion.responses?.["200"]?.content?.["application/json"]?.schema).toEqual(
			z.toJSONSchema(HumanReviewCommandStatusResponseSchema),
		);
		for (const [path, schema] of [
			["/api/v1/documents/{documentId}/source-pdf", AgentSourcePdfResponseSchema],
			[
				"/api/v1/documents/{documentId}/signature-profiles/selected",
				AgentSignatureProfileResponseSchema,
			],
			["/api/v1/documents/{documentId}/signing-task", AgentSelfSignTaskResponseSchema],
		] as const) {
			const operation = document.paths[path]?.get as {
				responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
			};
			expect(operation.responses?.["200"]?.content?.["application/json"]?.schema).toEqual(
				z.toJSONSchema(schema),
			);
		}
		const upload = document.paths["/api/v1/documents/{documentId}/source-pdf"]?.put as {
			requestBody?: { content?: Record<string, { schema?: unknown }> };
			responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
		};
		expect(upload.requestBody?.content?.["application/pdf"]?.schema).toEqual({
			type: "string",
			format: "binary",
			maxLength: MAX_SOURCE_PDF_BYTES,
			description: `At most ${MAX_SOURCE_PDF_BYTES} bytes and ${MAX_SOURCE_PDF_PAGES} PDF pages`,
		});
		expect(upload.responses?.["201"]?.content?.["application/json"]?.schema).toEqual(
			z.toJSONSchema(AgentSourcePdfResponseSchema),
		);

		const serialized = JSON.stringify(document);
		expect(serialized).toContain("IDEMPOTENCY_KEY_REQUIRED");
		expect(serialized).toContain("IDEMPOTENCY_CONFLICT");
		expect(serialized).toContain("INVALID_SOURCE_PDF");
		expect(serialized).toContain("SOURCE_PDF_TOO_LARGE");
		expect(serialized).toContain("allowedActions");
		expect(serialized).toContain("recoveryUrl");
		expect(serialized).not.toMatch(/senderSessionToken|signerToken|x-internal-user-id/);

		const guidance = await publicAgentContractHono.request("/agent.md");
		const markdown = await guidance.text();
		for (const phrase of [
			"Create a self-sign draft",
			"Upload one source PDF",
			"Save a signature profile",
			"Place signature and date fields",
			"Review and reposition",
			"Complete self-signing",
			"Use a fresh Idempotency-Key",
		]) {
			expect(markdown).toContain(phrase);
		}
	});

	it("agent API contract publishes two-party preparation, delivery, resend, and recovery", async () => {
		const response = await publicAgentContractHono.request("/openapi.json");
		const document = (await response.json()) as {
			paths: Record<string, Record<string, unknown>>;
		};
		const operations = [
			["get", "/api/v1/documents/{documentId}/recipients", "listAgentRecipients", false],
			["post", "/api/v1/documents/{documentId}/recipients", "addAgentRecipients", true],
			[
				"patch",
				"/api/v1/documents/{documentId}/recipients/{recipientId}",
				"updateAgentRecipient",
				true,
			],
			[
				"delete",
				"/api/v1/documents/{documentId}/recipients/{recipientId}",
				"deleteAgentRecipient",
				true,
			],
			["get", "/api/v1/documents/{documentId}/fields", "listAgentFields", false],
			["post", "/api/v1/documents/{documentId}/send", "sendAgentDocument", true],
			[
				"post",
				"/api/v1/documents/{documentId}/recipients/{recipientId}/resend",
				"resendAgentInvitation",
				true,
			],
		] as const;
		for (const [method, path, operationId, mutates] of operations) {
			const operation = document.paths[path]?.[method] as
				| { operationId?: string; security?: unknown; parameters?: Array<{ name?: string }> }
				| undefined;
			expect(operation).toEqual(
				expect.objectContaining({ operationId, security: [{ bearerAuth: [] }] }),
			);
			if (mutates) {
				expect(operation?.parameters?.map((parameter) => parameter.name)).toContain(
					"Idempotency-Key",
				);
			}
		}
		const contracts = [
			[
				"post",
				"/api/v1/documents/{documentId}/recipients",
				"201",
				AgentRecipientsAddRequestSchema,
				AgentRecipientsResponseSchema,
			],
			[
				"patch",
				"/api/v1/documents/{documentId}/recipients/{recipientId}",
				"200",
				AgentRecipientCreateSchema,
				AgentRecipientResponseSchema,
			],
			[
				"delete",
				"/api/v1/documents/{documentId}/recipients/{recipientId}",
				"200",
				AgentEmptyCommandRequestSchema,
				AgentRecipientResponseSchema,
			],
			[
				"post",
				"/api/v1/documents/{documentId}/send",
				"200",
				AgentEmptyCommandRequestSchema,
				AgentTwoPartySendResponseSchema,
			],
			[
				"post",
				"/api/v1/documents/{documentId}/recipients/{recipientId}/resend",
				"201",
				AgentEmptyCommandRequestSchema,
				AgentTwoPartyResendResponseSchema,
			],
		] as const;
		for (const [method, path, status, requestSchema, responseSchema] of contracts) {
			const operation = document.paths[path]?.[method] as {
				requestBody?: { content?: Record<string, { schema?: unknown }> };
				responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
			};
			expect(operation.requestBody?.content?.["application/json"]?.schema).toEqual(
				z.toJSONSchema(requestSchema),
			);
			expect(operation.responses?.[status]?.content?.["application/json"]?.schema).toEqual(
				z.toJSONSchema(responseSchema),
			);
		}
		for (const [path, schema] of [
			["/api/v1/documents/{documentId}/recipients", AgentRecipientsResponseSchema],
			["/api/v1/documents/{documentId}/fields", AgentFieldsResponseSchema],
		] as const) {
			const operation = document.paths[path]?.get as {
				responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
			};
			expect(operation.responses?.["200"]?.content?.["application/json"]?.schema).toEqual(
				z.toJSONSchema(schema),
			);
		}
		expect(JSON.stringify(document)).toContain("EMAIL_DELIVERY_FAILED");
		expect(
			(
				document.paths["/api/v1/documents/{documentId}/send"]?.post as {
					responses?: Record<string, unknown>;
				}
			).responses,
		).toHaveProperty("502");

		const guidance = await publicAgentContractHono.request("/agent.md");
		const markdown = await guidance.text();
		for (const phrase of [
			"Create a two-party draft",
			"Manage draft recipients",
			"Complete creator signing",
			"Send the partner invitation",
			"Resend an eligible invitation",
			"Delivery-provider failure",
			"Poll partner progress",
		]) {
			expect(markdown).toContain(phrase);
		}
		expect(markdown).not.toMatch(/signerToken|senderSessionToken|x-internal-user-id/);
	});
});
