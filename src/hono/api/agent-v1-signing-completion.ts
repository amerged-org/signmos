import {
	authorizeAgentPartnerSigning,
	getAgentSelfSignToken,
	getAuthorizedAgentCreatorEnvelope,
	recordAgentDocumentRead,
} from "@/db/agentic-access";
import type { AgenticPrincipal } from "@/db/agentic-access/bearer-principal";
import { AgentSelfSignCompleteResponseSchema } from "@/db/agentic-access/schema";
import {
	type CompleteSigningRequest,
	CreatorSigningBlockedError,
	completeDraftCreatorSigning,
	completeSigning,
	EmailDeliveryError,
	type EmailDeliveryOptions,
	type SignerToken,
	SigningCompletionBlockedError,
	SigningFinalizationError,
	SigningNoAssignedFieldsError,
} from "@/db/envelope";
import { agentPartnerAuthorizationError } from "./agent-partner-errors";
import { agentError } from "./agent-v1-command-helpers";

type AgentCompletionTarget =
	| { kind: "self"; token: SignerToken }
	| { kind: "partner"; token: SignerToken }
	| { kind: "creator" };

export async function executeAgentSigningCompletion(input: {
	principal: AgenticPrincipal;
	documentId: string;
	request: CompleteSigningRequest;
	now: Date;
	requestIp?: string;
	documentsBucket?: R2Bucket;
	emailDelivery: EmailDeliveryOptions;
}): Promise<Response> {
	try {
		const target = await resolveAgentCompletionTarget(input);
		if (target instanceof Response) return target;
		const result = await completeTarget(input, target);
		const body = AgentSelfSignCompleteResponseSchema.parse({ data: result });
		await recordAgentDocumentRead({
			principal: input.principal,
			documentId: input.documentId,
			eventType: completionEventType(target),
			requestIp: input.requestIp,
		});
		return Response.json(body);
	} catch (error) {
		return handleAgentCompletionError(input.documentId, error);
	}
}

async function completeTarget(
	input: Parameters<typeof executeAgentSigningCompletion>[0],
	target: AgentCompletionTarget,
) {
	if (target.kind === "creator") {
		return completeDraftCreatorSigning({
			envelopeId: input.documentId,
			creatorEmail: input.principal.email,
			completion: input.request,
			now: input.now,
		});
	}
	return completeSigning(target.token, input.request, {
		documentsBucket: input.documentsBucket,
		now: input.now,
		...(target.kind === "partner" ? { emailDelivery: input.emailDelivery } : {}),
	});
}

async function resolveAgentCompletionTarget(input: {
	principal: AgenticPrincipal;
	documentId: string;
}): Promise<AgentCompletionTarget | Response> {
	const envelope = await getAuthorizedAgentCreatorEnvelope(input.principal, input.documentId);
	if (envelope?.signingMode === "only_me") {
		const token = await getAgentSelfSignToken(input.principal, input.documentId);
		return token ? { kind: "self", token } : completeSigningTaskMissing(input.documentId);
	}
	if (envelope) return { kind: "creator" };
	const authorization = await authorizeAgentPartnerSigning(input.principal, input.documentId, {
		allowCompletionRetry: true,
	});
	if (authorization.state === "active") return { kind: "partner", token: authorization.token };
	const error = agentPartnerAuthorizationError(authorization, input.documentId);
	return knownErrorResponse(error.status, error.body);
}

function completionEventType(target: AgentCompletionTarget) {
	if (target.kind === "partner") return "agentic.partner.completed" as const;
	if (target.kind === "self") return "agentic.self_sign.completed" as const;
	return "agentic.creator_signing.completed" as const;
}

function handleAgentCompletionError(documentId: string, error: unknown): Response {
	if (error instanceof SigningFinalizationError) {
		return knownErrorResponse(
			503,
			agentError({
				code: error.code,
				message: error.message,
				retryable: true,
				allowedActions: ["retry_completion"],
				recoveryUrl: `/api/v1/documents/${documentId}/signing-task`,
			}),
		);
	}
	if (error instanceof EmailDeliveryError) {
		return knownErrorResponse(502, completionEmailError(documentId));
	}
	if (
		error instanceof SigningCompletionBlockedError ||
		error instanceof SigningNoAssignedFieldsError ||
		error instanceof CreatorSigningBlockedError
	) {
		return knownErrorResponse(409, blockedError(documentId, error.message));
	}
	throw error;
}

function completeSigningTaskMissing(documentId: string): Response {
	return knownErrorResponse(
		404,
		agentError({
			code: "AGENT_SIGNING_TASK_NOT_FOUND",
			message: "Self-signing task not found",
			retryable: false,
			allowedActions: ["get_document_status"],
			recoveryUrl: `/api/v1/documents/${documentId}/status`,
		}),
	);
}

function knownErrorResponse(status: number, body: unknown): Response {
	return Response.json(body, { status });
}

function blockedError(documentId: string, message: string) {
	return agentError({
		code: "AGENT_SELF_SIGN_ACTION_BLOCKED",
		message,
		retryable: false,
		allowedActions: ["get_document_status"],
		recoveryUrl: `/api/v1/documents/${documentId}/status`,
	});
}

function completionEmailError(documentId: string) {
	return agentError({
		code: "EMAIL_DELIVERY_FAILED",
		message: "Email provider rejected the message",
		retryable: true,
		allowedActions: ["retry_completion"],
		recoveryUrl: `/api/v1/documents/${documentId}/signing-task`,
	});
}
