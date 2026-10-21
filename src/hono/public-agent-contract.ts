import { z } from "zod";
import {
	agentHumanReviewOperations,
	HumanReviewCommandStatusResponseSchema,
	PendingHumanReviewCommandResponseSchema,
} from "@/db/agentic-access/human-review-schema";
import {
	AgentDocumentErrorSchema,
	AgentDocumentGroupSchema,
	AgentDocumentRoleSchema,
	AgentFieldsResponseSchema,
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
	AgentV1AuthenticationErrorSchema,
	agentDocumentOperations,
	agentSelfSignOperations,
	agentTwoPartyOperations,
	agentV1IdentityOperation,
} from "@/db/agentic-access/schema";
import { MAX_SOURCE_PDF_BYTES, MAX_SOURCE_PDF_PAGES } from "@/db/envelope/pdf-policy-limits";
import { EnvelopeStatusSchema } from "@/db/envelope/schema";
import { createHono } from "./factory";
import { buildAgentCreatorControlPaths } from "./public-agent-creator-control-contract";
import { buildAgentGuidance } from "./public-agent-guidance";
import { buildAgentPartnerPaths } from "./public-agent-partner-contract";
import { agentRateLimitErrorResponse } from "./public-agent-rate-limit-contract";
import { buildAgentTwoPartyPaths } from "./public-agent-two-party-contract";

export const publicAgentContractHono = createHono();

publicAgentContractHono.get("/agent.md", (c) =>
	c.text(buildAgentGuidance(), 200, { "content-type": "text/markdown; charset=UTF-8" }),
);

publicAgentContractHono.get("/openapi.json", (c) => c.json(buildAgentOpenApiDocument()));

function buildAgentOpenApiDocument() {
	const documentIdParameter = {
		name: "documentId",
		in: "path",
		required: true,
		schema: { type: "string", format: "uuid" },
	};
	const fieldIdParameter = {
		name: "fieldId",
		in: "path",
		required: true,
		schema: { type: "string", format: "uuid" },
	};
	const commandIdParameter = {
		name: "commandId",
		in: "path",
		required: true,
		schema: { type: "string", format: "uuid" },
	};
	return {
		openapi: "3.1.0",
		info: {
			title: "Signmos Agent API",
			version: "1.0.0",
			description: "Bearer-authenticated personal document automation for Signmos.",
		},
		paths: {
			[agentHumanReviewOperations.commandStatus.publicPath]: {
				get: {
					...jsonOperation({
						operationId: agentHumanReviewOperations.commandStatus.operationId,
						summary: "Poll a human-review command created by this exact personal token",
						responseDescription: "Pending or terminal human-review command status",
						responseSchema: HumanReviewCommandStatusResponseSchema,
						documentErrors: false,
					}),
					parameters: [commandIdParameter],
				},
			},
			[agentV1IdentityOperation.publicPath]: {
				get: jsonOperation({
					operationId: agentV1IdentityOperation.operationId,
					summary: "Resolve the current verified Agentic identity",
					responseDescription: "Authenticated identity and safe token metadata",
					responseSchema: agentV1IdentityOperation.responseSchema,
					documentErrors: false,
				}),
			},
			[agentDocumentOperations.catalog.publicPath]: {
				get: {
					...jsonOperation({
						operationId: agentDocumentOperations.catalog.operationId,
						summary: "List retained documents available to the verified identity",
						responseDescription: "Role-aware, action-first document catalog",
						responseSchema: agentDocumentOperations.catalog.responseSchema,
					}),
					parameters: catalogParameters(),
				},
				post: commandOperation({
					operationId: agentSelfSignOperations.create.operationId,
					summary: "Create a verified self-sign draft",
					requestSchema: AgentSelfSignCreateRequestSchema,
					responseSchema: AgentSelfSignCreateResponseSchema,
					responseStatus: "201",
				}),
			},
			[agentDocumentOperations.detail.publicPath]: {
				get: {
					...jsonOperation({
						operationId: agentDocumentOperations.detail.operationId,
						summary: "Inspect authorized document detail",
						responseDescription: "Lifecycle, role, retention, actions, and public history",
						responseSchema: agentDocumentOperations.detail.responseSchema,
					}),
					parameters: [documentIdParameter],
				},
			},
			[agentDocumentOperations.status.publicPath]: {
				get: {
					...jsonOperation({
						operationId: agentDocumentOperations.status.operationId,
						summary: "Poll authorized document lifecycle status",
						responseDescription: "Current status and server-derived allowed actions",
						responseSchema: agentDocumentOperations.status.responseSchema,
					}),
					parameters: [documentIdParameter],
				},
			},
			[agentDocumentOperations.history.publicPath]: {
				get: {
					...jsonOperation({
						operationId: agentDocumentOperations.history.operationId,
						summary: "Read authorized user-facing document history",
						responseDescription: "Public lifecycle history without internal security events",
						responseSchema: agentDocumentOperations.history.responseSchema,
					}),
					parameters: [documentIdParameter],
				},
			},
			[agentDocumentOperations.finalPdf.publicPath]: {
				get: {
					operationId: agentDocumentOperations.finalPdf.operationId,
					summary: "Download an authorized completed final PDF",
					security: [{ bearerAuth: [] }],
					parameters: [documentIdParameter],
					responses: {
						"200": {
							description: "Final PDF bytes",
							content: {
								"application/pdf": { schema: { type: "string", format: "binary" } },
							},
						},
						...agentErrorResponses(),
					},
				},
			},
			[agentSelfSignOperations.sourceUpload.publicPath]: {
				put: commandOperation({
					operationId: agentSelfSignOperations.sourceUpload.operationId,
					summary: "Upload an initial or revised creator-owned source PDF",
					requestContent: {
						"application/pdf": {
							schema: {
								type: "string",
								format: "binary",
								maxLength: MAX_SOURCE_PDF_BYTES,
								description: `At most ${MAX_SOURCE_PDF_BYTES} bytes and ${MAX_SOURCE_PDF_PAGES} PDF pages`,
							},
						},
					},
					responseSchema: AgentSourcePdfResponseSchema,
					responseStatus: "201",
					parameters: [documentIdParameter, sourceFilenameParameter()],
				}),
				get: {
					...jsonOperation({
						operationId: agentSelfSignOperations.sourceMetadata.operationId,
						summary: "Inspect the authorized current source PDF metadata",
						responseDescription: "Current source PDF metadata and preparation URL",
						responseSchema: AgentSourcePdfResponseSchema,
					}),
					parameters: [documentIdParameter],
				},
			},
			[agentSelfSignOperations.sourceContent.publicPath]: {
				get: binaryReadOperation(
					agentSelfSignOperations.sourceContent.operationId,
					"Download the authorized source PDF for preparation",
					[documentIdParameter],
				),
			},
			[agentSelfSignOperations.profileCreate.publicPath]: {
				post: commandOperation({
					operationId: agentSelfSignOperations.profileCreate.operationId,
					summary: "Save a reusable typed or drawn signature with explicit consent",
					requestSchema: AgentSignatureProfileCreateRequestSchema,
					responseSchema: AgentSignatureProfileResponseSchema,
					responseStatus: "201",
					parameters: [documentIdParameter],
				}),
			},
			[agentSelfSignOperations.profileSelected.publicPath]: {
				get: {
					...jsonOperation({
						operationId: agentSelfSignOperations.profileSelected.operationId,
						summary: "Read the latest selected signature for this verified identity",
						responseDescription: "Selected signature profile or null",
						responseSchema: AgentSignatureProfileResponseSchema,
					}),
					parameters: [documentIdParameter],
				},
			},
			[agentSelfSignOperations.fieldsExplicit.publicPath]: {
				get: {
					...jsonOperation({
						operationId: agentTwoPartyOperations.fieldsList.operationId,
						summary: "List creator-managed document fields",
						responseDescription: "Current safe field assignments and geometry",
						responseSchema: AgentFieldsResponseSchema,
					}),
					parameters: [documentIdParameter],
				},
				post: commandOperation({
					operationId: agentSelfSignOperations.fieldsExplicit.operationId,
					summary: "Place explicit self-sign signature/date fields",
					requestSchema: AgentSelfSignFieldsRequestSchema,
					responseSchema: AgentSelfSignFieldsResponseSchema,
					responseStatus: "201",
					parameters: [documentIdParameter],
				}),
			},
			[agentSelfSignOperations.fieldsDefault.publicPath]: {
				post: commandOperation({
					operationId: agentSelfSignOperations.fieldsDefault.operationId,
					summary: "Place default self-sign signature/date fields",
					requestSchema: AgentSelfSignDefaultFieldsRequestSchema,
					responseSchema: AgentSelfSignFieldsResponseSchema,
					responseStatus: "201",
					parameters: [documentIdParameter],
				}),
			},
			[agentSelfSignOperations.signingTask.publicPath]: {
				get: {
					...jsonOperation({
						operationId: agentSelfSignOperations.signingTask.operationId,
						summary: "Review the Bearer-authorized self-signing task",
						responseDescription: "Assigned source, fields, and selected signature",
						responseSchema: AgentSelfSignTaskResponseSchema,
					}),
					parameters: [documentIdParameter],
				},
			},
			[agentSelfSignOperations.fieldReposition.publicPath]: {
				patch: commandOperation({
					operationId: agentSelfSignOperations.fieldReposition.operationId,
					summary: "Reposition one assigned self-sign field",
					requestSchema: AgentSelfSignFieldPlacementRequestSchema,
					responseSchema: AgentSelfSignFieldPlacementResponseSchema,
					responseStatus: "200",
					parameters: [documentIdParameter, fieldIdParameter],
				}),
			},
			[agentSelfSignOperations.complete.publicPath]: {
				post: humanReviewCommandOperation({
					operationId: agentSelfSignOperations.complete.operationId,
					summary: "Request human-reviewed typed or drawn signing using the server date",
					requestSchema: AgentSelfSignCompleteRequestSchema,
					parameters: [documentIdParameter],
				}),
			},
			...buildAgentTwoPartyPaths(),
			...buildAgentPartnerPaths(),
			...buildAgentCreatorControlPaths(),
		},
		components: {
			securitySchemes: {
				bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "SignmosToken" },
			},
		},
	};
}

function commandOperation(input: {
	operationId: string;
	summary: string;
	responseSchema: z.ZodType;
	responseStatus: "200" | "201";
	requestSchema?: z.ZodType;
	requestContent?: Record<string, { schema: unknown }>;
	parameters?: Array<Record<string, unknown>>;
}) {
	return {
		operationId: input.operationId,
		summary: input.summary,
		security: [{ bearerAuth: [] }],
		parameters: [...(input.parameters ?? []), idempotencyKeyParameter()],
		requestBody: {
			required: true,
			content:
				input.requestContent ??
				(input.requestSchema
					? { "application/json": { schema: z.toJSONSchema(input.requestSchema) } }
					: {}),
		},
		responses: {
			[input.responseStatus]: {
				description: "Command completed or exact result replayed",
				content: { "application/json": { schema: z.toJSONSchema(input.responseSchema) } },
			},
			...agentErrorResponses(),
		},
	};
}

function humanReviewCommandOperation(input: {
	operationId: string;
	summary: string;
	requestSchema: z.ZodType;
	parameters: Array<Record<string, unknown>>;
}) {
	return {
		operationId: input.operationId,
		summary: input.summary,
		security: [{ bearerAuth: [] }],
		parameters: [...input.parameters, idempotencyKeyParameter()],
		requestBody: {
			required: true,
			content: { "application/json": { schema: z.toJSONSchema(input.requestSchema) } },
		},
		responses: {
			"202": {
				description: "Protected action persisted pending matching-human review",
				content: {
					"application/json": {
						schema: z.toJSONSchema(PendingHumanReviewCommandResponseSchema),
					},
				},
			},
			"200": {
				description: "Exact replay of a terminal human-review command",
				content: {
					"application/json": {
						schema: z.toJSONSchema(HumanReviewCommandStatusResponseSchema),
					},
				},
			},
			...agentErrorResponses(),
		},
	};
}

function binaryReadOperation(
	operationId: string,
	summary: string,
	parameters: Array<Record<string, unknown>>,
) {
	return {
		operationId,
		summary,
		security: [{ bearerAuth: [] }],
		parameters,
		responses: {
			"200": {
				description: "PDF bytes",
				content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
			},
			...agentErrorResponses(),
		},
	};
}

function jsonOperation(input: {
	operationId: string;
	summary: string;
	responseDescription: string;
	responseSchema: z.ZodType;
	documentErrors?: boolean;
}) {
	return {
		operationId: input.operationId,
		summary: input.summary,
		security: [{ bearerAuth: [] }],
		responses: {
			"200": {
				description: input.responseDescription,
				content: {
					"application/json": { schema: z.toJSONSchema(input.responseSchema) },
				},
			},
			...(input.documentErrors === false
				? {
						"401": agentErrorResponses()["401"],
						"429": agentRateLimitErrorResponse(),
					}
				: agentErrorResponses()),
		},
	};
}

function agentErrorResponses() {
	return {
		"400": agentErrorResponse("Invalid query"),
		"401": {
			description: "Missing, revoked, or invalid Bearer token",
			content: {
				"application/json": { schema: z.toJSONSchema(AgentV1AuthenticationErrorSchema) },
			},
		},
		"404": agentErrorResponse("Document is not visible to this identity"),
		"409": agentErrorResponse("Final PDF is not ready"),
		"413": agentErrorResponse("PDF size, page, or signing-field limit exceeded"),
		"429": agentRateLimitErrorResponse(),
		"503": agentErrorResponse("Final PDF object is temporarily unavailable"),
		"502": agentErrorResponse("Configured delivery provider rejected the request"),
	};
}

function agentErrorResponse(description: string) {
	return {
		description,
		content: { "application/json": { schema: z.toJSONSchema(AgentDocumentErrorSchema) } },
	};
}

function catalogParameters() {
	return [
		queryParameter("search", z.string().max(200)),
		queryParameter("role", AgentDocumentRoleSchema),
		queryParameter("group", AgentDocumentGroupSchema),
		queryParameter("status", EnvelopeStatusSchema.exclude(["deleted"])),
		queryParameter("page", z.number().int().positive()),
	];
}

function queryParameter(name: string, schema: z.ZodType) {
	return { name, in: "query", required: false, schema: z.toJSONSchema(schema) };
}

function idempotencyKeyParameter() {
	return {
		name: "Idempotency-Key",
		in: "header",
		required: true,
		schema: { type: "string", minLength: 1, maxLength: 200 },
	};
}

function sourceFilenameParameter() {
	return {
		name: "X-Source-Filename",
		in: "header",
		required: false,
		schema: { type: "string", maxLength: 255 },
	};
}
