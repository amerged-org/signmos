import {
	type AgenticPrincipal,
	authorizeAgentPartnerSigning,
	claimHumanReviewCommand,
	fingerprintAgentCommand,
	getAgentSelfSignToken,
	getAuthorizedAgentCreatorEnvelope,
	listAgentCreatorFields,
	listAgentCreatorRecipients,
	listAgentPartnerFields,
} from "@/db/agentic-access";
import { type EmailDeliveryOptions, getLatestSourcePdfDocument } from "@/db/envelope";
import { agentPartnerAuthorizationError } from "./agent-partner-errors";
import { agentError, commandClaimResponse } from "./agent-v1-command-helpers";
import { deliverHumanReviewNotification } from "./agent-v1-human-review-notification";
import type { executeAgentSigningCompletion } from "./agent-v1-signing-completion";

type QueueSigningCompletionReviewInput = {
	principal: AgenticPrincipal;
	documentId: string;
	request: Parameters<typeof executeAgentSigningCompletion>[0]["request"];
	requestFingerprint: string;
	idempotencyKey: string;
	operation: string;
	now: Date;
	baseUrl: string;
	emailDelivery: EmailDeliveryOptions;
};

type ReviewField = {
	id: string;
	type: string;
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
};

type SigningReviewContext = {
	recipientId: string;
	fields: ReviewField[];
};

export async function queueSigningCompletionReview(
	input: QueueSigningCompletionReviewInput,
): Promise<Response> {
	const review = await resolveSigningReviewContext(input);
	if (review instanceof Response) return review;
	const source = await getLatestSourcePdfDocument(input.documentId);
	if (!source || review.fields.length === 0) {
		return Response.json(
			blockedError(input.documentId, "Signing requires a current source and fields"),
			{ status: 409 },
		);
	}
	const claim = await claimHumanReviewCommand({
		principal: input.principal,
		idempotencyKey: input.idempotencyKey,
		operation: input.operation,
		requestFingerprint: input.requestFingerprint,
		documentId: input.documentId,
		reviewer: {
			email: input.principal.email,
			role: "signer",
			recipientId: review.recipientId,
			fields: review.fields,
		},
		source: {
			id: source.id,
			version: source.version,
			sha256: source.sha256,
			originalFilename: source.originalFilename,
		},
		actionPayload: input.request,
		actionPayloadDigest: await fingerprintAgentCommand(input.request),
		baseUrl: input.baseUrl,
		now: input.now,
	});
	if (claim.state !== "created") return commandClaimResponse(claim);
	const response = await deliverHumanReviewNotification({
		principal: input.principal,
		documentId: input.documentId,
		intentAuditEvent: "agentic.human_review.signing_requested",
		commandId: claim.commandId,
		response: claim.response,
		reviewerEmail: input.principal.email,
		documentName: source.originalFilename,
		actionLabel: "Sign and complete",
		agentName: input.principal.token.name,
		consequence: "This will sign the current document and may complete it.",
		emailDelivery: input.emailDelivery,
	});
	return Response.json(response, { status: 202 });
}

async function resolveSigningReviewContext(
	input: QueueSigningCompletionReviewInput,
): Promise<SigningReviewContext | Response> {
	const creatorEnvelope = await getAuthorizedAgentCreatorEnvelope(
		input.principal,
		input.documentId,
	);
	if (creatorEnvelope?.signingMode === "only_me") {
		return resolveSelfSignReviewContext(input, creatorEnvelope.status);
	}
	if (creatorEnvelope) return resolveCreatorReviewContext(input, creatorEnvelope.status);
	return resolvePartnerReviewContext(input);
}

async function resolveSelfSignReviewContext(
	input: QueueSigningCompletionReviewInput,
	status: string,
): Promise<SigningReviewContext | Response> {
	if (status !== "sent") {
		return Response.json(blockedError(input.documentId, `Signing is blocked while ${status}`), {
			status: 409,
		});
	}
	const token = await getAgentSelfSignToken(input.principal, input.documentId);
	if (!token) return Response.json(signingTaskNotFoundError(input.documentId), { status: 404 });
	return {
		recipientId: token.recipientId,
		fields: snapshotFields(await listAgentPartnerFields(token)),
	};
}

async function resolveCreatorReviewContext(
	input: QueueSigningCompletionReviewInput,
	status: string,
): Promise<SigningReviewContext | Response> {
	if (status !== "draft") {
		return Response.json(
			blockedError(input.documentId, `Creator signing is blocked while ${status}`),
			{ status: 409 },
		);
	}
	const [recipients, fields] = await Promise.all([
		listAgentCreatorRecipients(input.principal, input.documentId),
		listAgentCreatorFields(input.principal, input.documentId),
	]);
	const reviewer = recipients?.find(
		(recipient) => normalizeEmail(recipient.email) === normalizeEmail(input.principal.email),
	);
	if (!reviewer || reviewer.status === "completed") {
		return Response.json(signingTaskNotFoundError(input.documentId), { status: 404 });
	}
	return {
		recipientId: reviewer.id,
		fields: snapshotFields(fields?.filter((field) => field.recipientId === reviewer.id) ?? []),
	};
}

async function resolvePartnerReviewContext(
	input: QueueSigningCompletionReviewInput,
): Promise<SigningReviewContext | Response> {
	const authorization = await authorizeAgentPartnerSigning(input.principal, input.documentId, {
		allowCompletionRetry: true,
	});
	if (authorization.state !== "active") {
		const error = agentPartnerAuthorizationError(authorization, input.documentId);
		return Response.json(error.body, { status: error.status });
	}
	return {
		recipientId: authorization.token.recipientId,
		fields: snapshotFields(await listAgentPartnerFields(authorization.token)),
	};
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function snapshotFields(fields: ReviewField[]) {
	return fields.map(({ id, type, page, x, y, width, height }) => ({
		id,
		type,
		page,
		x,
		y,
		width,
		height,
	}));
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

function signingTaskNotFoundError(documentId: string) {
	return agentError({
		code: "AGENT_SIGNING_TASK_NOT_FOUND",
		message: "Signing task not found",
		retryable: false,
		allowedActions: ["get_document_status"],
		recoveryUrl: `/api/v1/documents/${documentId}/status`,
	});
}
