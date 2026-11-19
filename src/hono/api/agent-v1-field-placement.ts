import {
	AgentSelfSignPreparationError,
	AgentTwoPartyPreparationError,
	claimAgentCommand,
	completeAgentCommand,
	fingerprintAgentCommand,
	getAuthorizedAgentCreatorEnvelope,
	prepareAgentSelfSignFields,
	prepareAgentTwoPartyFields,
	recordAgentDocumentRead,
} from "@/db/agentic-access";
import type { AgenticPrincipal } from "@/db/agentic-access/bearer-principal";
import { AgentSelfSignFieldsResponseSchema } from "@/db/agentic-access/schema";
import { SignaturePlaceholderLimitError, toEnvelopeFieldResponse } from "@/db/envelope";
import { PdfPolicyError } from "@/db/envelope/pdf-policy";
import {
	agentError,
	commandClaimResponse,
	documentNotFoundError,
	parsedUuid,
} from "./agent-v1-command-helpers";

type FieldPlacement = Parameters<typeof prepareAgentTwoPartyFields>[0]["placement"];

export async function placeAgentFieldsCommand(input: {
	principal: AgenticPrincipal;
	documentId?: string;
	idempotencyKey: string;
	operation: string;
	request: unknown;
	placement: FieldPlacement;
	now: Date;
	requestIp?: string;
}): Promise<Response> {
	const documentId = parsedUuid(input.documentId);
	if (!documentId) return Response.json(documentNotFoundError(), { status: 404 });
	const claim = await claimAgentCommand({
		principal: input.principal,
		idempotencyKey: input.idempotencyKey,
		operation: input.operation,
		requestFingerprint: await fingerprintAgentCommand({
			documentId,
			...objectValue(input.request),
		}),
	});
	if (claim.state !== "execute") return commandClaimResponse(claim);
	try {
		return await executeFieldPlacement({ ...input, documentId, recordId: claim.recordId });
	} catch (error) {
		return handleFieldPlacementError(claim.recordId, documentId, error);
	}
}

async function executeFieldPlacement(input: {
	principal: AgenticPrincipal;
	documentId: string;
	placement: FieldPlacement;
	now: Date;
	requestIp?: string;
	recordId: string;
}): Promise<Response> {
	const envelope = await getAuthorizedAgentCreatorEnvelope(input.principal, input.documentId);
	if (!envelope)
		return completeFieldError(input.recordId, input.documentId, 404, documentNotFoundError());
	const fields =
		envelope.signingMode === "only_me"
			? await prepareAgentSelfSignFields({
					principal: input.principal,
					documentId: input.documentId,
					placement: selfPlacement(input.placement),
					now: input.now,
				})
			: await prepareAgentTwoPartyFields({
					principal: input.principal,
					documentId: input.documentId,
					placement: input.placement,
				});
	const body = AgentSelfSignFieldsResponseSchema.parse({
		data: {
			documentId: input.documentId,
			status: envelope.signingMode === "only_me" ? "sent" : "draft",
			fields: fields.map(toEnvelopeFieldResponse),
		},
	});
	await recordAgentDocumentRead({
		principal: input.principal,
		documentId: input.documentId,
		eventType: "agentic.fields.prepared",
		requestIp: input.requestIp,
	});
	await completeAgentCommand({
		recordId: input.recordId,
		status: 201,
		body,
		documentId: input.documentId,
		now: input.now,
	});
	return Response.json(body, { status: 201 });
}

function selfPlacement(
	placement: FieldPlacement,
): Parameters<typeof prepareAgentSelfSignFields>[0]["placement"] {
	return placement.kind === "default"
		? { kind: "default", page: placement.page }
		: {
				kind: "explicit",
				fields: placement.fields.map(({ recipientId: _recipientId, ...field }) => field),
			};
}

function handleFieldPlacementError(
	recordId: string,
	documentId: string,
	error: unknown,
): Promise<Response> {
	if (error instanceof PdfPolicyError) {
		return completeFieldError(
			recordId,
			documentId,
			error.status,
			agentError({
				code: error.code,
				message: error.message,
				retryable: false,
				allowedActions: ["place_fields"],
				recoveryUrl: `/api/v1/documents/${documentId}/fields`,
			}),
		);
	}
	if (error instanceof SignaturePlaceholderLimitError) {
		return completeFieldError(
			recordId,
			documentId,
			409,
			agentError({
				code: "SIGNATURE_PLACEHOLDER_LIMIT",
				message: error.message,
				retryable: false,
				allowedActions: ["get_signing_task"],
				recoveryUrl: `/api/v1/documents/${documentId}/signing-task`,
			}),
		);
	}
	if (error instanceof AgentSelfSignPreparationError) {
		return completePreparationError(recordId, documentId, error.code, error.message);
	}
	if (error instanceof AgentTwoPartyPreparationError) {
		return completePreparationError(recordId, documentId, error.code, error.message);
	}
	throw error;
}

function completePreparationError(
	recordId: string,
	documentId: string,
	code:
		| "DOCUMENT_NOT_FOUND"
		| "PREPARATION_BLOCKED"
		| "SOURCE_REQUIRED"
		| "NOT_DRAFT"
		| "INVALID_RECIPIENT",
	message: string,
): Promise<Response> {
	if (code === "DOCUMENT_NOT_FOUND") {
		return completeFieldError(recordId, documentId, 404, documentNotFoundError());
	}
	if (code === "INVALID_RECIPIENT") {
		return completeFieldError(recordId, documentId, 400, invalidAgentFieldsError());
	}
	return completeFieldError(recordId, documentId, 409, blockedFieldsError(documentId, message));
}

async function completeFieldError(
	recordId: string,
	documentId: string,
	status: number,
	body: unknown,
): Promise<Response> {
	await completeAgentCommand({ recordId, status, body, documentId });
	return Response.json(body, { status });
}

function blockedFieldsError(documentId: string, message: string) {
	return agentError({
		code: "AGENT_SELF_SIGN_ACTION_BLOCKED",
		message,
		retryable: false,
		allowedActions: ["get_document_status"],
		recoveryUrl: `/api/v1/documents/${documentId}/status`,
	});
}

export function invalidAgentFieldsError() {
	return agentError({
		code: "INVALID_FIELDS",
		message: "Use valid recipients, signature/date fields, and PDF geometry",
		retryable: false,
		allowedActions: ["place_fields"],
		recoveryUrl: "/agent.md",
		validValues: ["signature", "date"],
		fields: ["fields"],
	});
}

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
