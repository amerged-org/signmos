import {
	authorizeAgentPartnerSigning,
	claimAgentCommand,
	completeAgentCommand,
	fingerprintAgentCommand,
	getAgentSelfSignToken,
	getAuthorizedAgentCreatorEnvelope,
	inspectHumanReviewCommand,
	recordAgentDocumentRead,
} from "@/db/agentic-access";
import type { AgenticPrincipal } from "@/db/agentic-access/bearer-principal";
import {
	AgentSelfSignCompleteRequestSchema,
	AgentSelfSignDefaultFieldsRequestSchema,
	AgentSelfSignFieldPlacementRequestSchema,
	AgentSelfSignFieldPlacementResponseSchema,
	AgentSelfSignFieldsRequestSchema,
	AgentSelfSignTaskResponseSchema,
	AgentSignatureProfileCreateRequestSchema,
	AgentSignatureProfileResponseSchema,
	agentSelfSignOperations,
} from "@/db/agentic-access/schema";
import {
	createSignatureProfile,
	type EmailDeliveryEnv,
	getLatestSelectedSignatureProfile,
	getSignerSession,
	SigningFieldPlacementBlockedError,
	SigningFieldPlacementNotFoundError,
	toSignatureProfileResponse,
	updateSignerFieldPlacement,
} from "@/db/envelope";
import { createAgentHono } from "@/hono/factory";
import { agentPartnerAuthorizationError } from "./agent-partner-errors";
import {
	agentError,
	commandClaimResponse,
	documentNotFoundError,
	parsedUuid,
	requestIp,
	requestNow,
	requiredIdempotencyKey,
} from "./agent-v1-command-helpers";
import { invalidAgentFieldsError, placeAgentFieldsCommand } from "./agent-v1-field-placement";
import { queueSigningCompletionReview } from "./agent-v1-signing-human-review";

const agentSelfSignSigningEndpoint = createAgentHono();

agentSelfSignSigningEndpoint.post(agentSelfSignOperations.profileCreate.relativePath, async (c) => {
	const raw: unknown = await c.req.json().catch(() => null);
	if (!hasReuseConsent(raw)) {
		return c.json(
			agentError({
				code: "SIGNATURE_REUSE_CONSENT_REQUIRED",
				message: "Set rememberSignature to true before storing reusable signature content",
				retryable: false,
				allowedActions: ["create_signature_profile"],
				recoveryUrl: "/agent.md",
				fields: ["rememberSignature"],
			}),
			400,
		);
	}
	const parsed = AgentSignatureProfileCreateRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json(
			agentError({
				code: "INVALID_SIGNATURE_PROFILE",
				message: "Use a valid typed or drawn signature profile",
				retryable: false,
				allowedActions: ["create_signature_profile"],
				recoveryUrl: "/agent.md",
				validValues: ["typed", "drawn"],
				fields: ["profile"],
			}),
			400,
		);
	}
	const documentId = parsedUuid(c.req.param("documentId"));
	if (!documentId) return c.json(documentNotFoundError(), 404);
	const principal = c.get("agenticPrincipal");
	const claim = await claimJsonCommand(
		c,
		principal,
		agentSelfSignOperations.profileCreate.operationId,
		parsed.data,
	);
	if (claim.state !== "execute") return commandClaimResponse(claim);
	const envelope = await getAuthorizedAgentCreatorEnvelope(principal, documentId);
	if (!envelope) return completeNotFound(claim.recordId, documentId);
	if (envelope.status !== "draft") {
		return completeBlocked(
			claim.recordId,
			documentId,
			"Signature profiles can only be prepared in draft",
		);
	}
	const profile = await createSignatureProfile({
		envelopeId: documentId,
		createdBy: principal.email,
		profile: parsed.data.profile,
	});
	const body = AgentSignatureProfileResponseSchema.parse({
		data: toSignatureProfileResponse(profile),
	});
	await recordMutation(principal, documentId, "agentic.signature_profile.created", c);
	await completeAgentCommand({
		recordId: claim.recordId,
		status: 201,
		body,
		documentId,
		now: requestNow(c),
	});
	return c.json(body, 201);
});

agentSelfSignSigningEndpoint.get(
	agentSelfSignOperations.profileSelected.relativePath,
	async (c) => {
		const documentId = parsedUuid(c.req.param("documentId"));
		if (!documentId) return c.json(documentNotFoundError(), 404);
		const principal = c.get("agenticPrincipal");
		if (!(await getAuthorizedAgentCreatorEnvelope(principal, documentId))) {
			return c.json(documentNotFoundError(), 404);
		}
		const profile = await getLatestSelectedSignatureProfile(principal.email);
		return c.json(
			AgentSignatureProfileResponseSchema.parse({
				data: profile ? toSignatureProfileResponse(profile) : null,
			}),
		);
	},
);

agentSelfSignSigningEndpoint.post(
	agentSelfSignOperations.fieldsExplicit.relativePath,
	async (c) => {
		const parsed = AgentSelfSignFieldsRequestSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) return c.json(invalidAgentFieldsError(), 400);
		return placeAgentFieldsCommand({
			principal: c.get("agenticPrincipal"),
			documentId: c.req.param("documentId"),
			idempotencyKey: requiredIdempotencyKey(c),
			operation: agentSelfSignOperations.fieldsExplicit.operationId,
			request: parsed.data,
			placement: { kind: "explicit", fields: parsed.data.fields },
			now: requestNow(c),
			requestIp: requestIp(c),
		});
	},
);

agentSelfSignSigningEndpoint.post(agentSelfSignOperations.fieldsDefault.relativePath, async (c) => {
	const parsed = AgentSelfSignDefaultFieldsRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	);
	if (!parsed.success) return c.json(invalidAgentFieldsError(), 400);
	return placeAgentFieldsCommand({
		principal: c.get("agenticPrincipal"),
		documentId: c.req.param("documentId"),
		idempotencyKey: requiredIdempotencyKey(c),
		operation: agentSelfSignOperations.fieldsDefault.operationId,
		request: parsed.data,
		placement: {
			kind: "default",
			page: parsed.data.page,
			recipientIds: parsed.data.recipientIds,
		},
		now: requestNow(c),
		requestIp: requestIp(c),
	});
});

agentSelfSignSigningEndpoint.get(agentSelfSignOperations.signingTask.relativePath, async (c) => {
	const documentId = parsedUuid(c.req.param("documentId"));
	if (!documentId) return c.json(documentNotFoundError(), 404);
	const principal = c.get("agenticPrincipal");
	const selfToken = await getAgentSelfSignToken(principal, documentId);
	const partnerAuthorization = selfToken
		? null
		: await authorizeAgentPartnerSigning(principal, documentId, { allowCompletionRetry: true });
	if (!selfToken && partnerAuthorization?.state !== "active") {
		const error = agentPartnerAuthorizationError(
			partnerAuthorization ?? { state: "not_found" },
			documentId,
		);
		return Response.json(error.body, { status: error.status });
	}
	const token =
		selfToken ?? (partnerAuthorization?.state === "active" ? partnerAuthorization.token : null);
	if (!token) return c.json(signingTaskNotFoundError(documentId), 404);
	const task = await getSignerSession(token, {
		sourceDownloadUrl: `/api/v1/documents/${documentId}/source-pdf/content`,
	});
	await recordMutation(principal, documentId, "agentic.signing_task.read", c);
	return c.json(
		AgentSelfSignTaskResponseSchema.parse({
			data: selfToken
				? task
				: {
						...task,
						previewFields: task.previewFields.filter(
							(field) => field.recipientId === token.recipientId,
						),
					},
		}),
	);
});

agentSelfSignSigningEndpoint.patch(
	agentSelfSignOperations.fieldReposition.relativePath,
	async (c) => {
		const documentId = parsedUuid(c.req.param("documentId"));
		const fieldId = parsedUuid(c.req.param("fieldId"));
		const parsed = AgentSelfSignFieldPlacementRequestSchema.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!documentId || !fieldId || !parsed.success) {
			return c.json(invalidFieldPlacementError(), 400);
		}
		const principal = c.get("agenticPrincipal");
		const claim = await claimJsonCommand(
			c,
			principal,
			agentSelfSignOperations.fieldReposition.operationId,
			{ documentId, fieldId, ...parsed.data },
		);
		if (claim.state !== "execute") return commandClaimResponse(claim);
		const token = await getAgentSelfSignToken(principal, documentId);
		if (!token) return completeSigningTaskMissing(claim.recordId, documentId);
		try {
			const field = await updateSignerFieldPlacement(token, { fieldId, ...parsed.data });
			const body = AgentSelfSignFieldPlacementResponseSchema.parse({ data: field });
			await recordMutation(principal, documentId, "agentic.field.repositioned", c);
			await completeAgentCommand({
				recordId: claim.recordId,
				status: 200,
				body,
				documentId,
				now: requestNow(c),
			});
			return c.json(body);
		} catch (error) {
			if (error instanceof SigningFieldPlacementNotFoundError) {
				return completeKnownError(
					claim.recordId,
					documentId,
					404,
					agentError({
						code: "FIELD_NOT_FOUND",
						message: error.message,
						retryable: false,
						allowedActions: ["get_signing_task"],
						recoveryUrl: `/api/v1/documents/${documentId}/signing-task`,
					}),
				);
			}
			if (error instanceof SigningFieldPlacementBlockedError) {
				return completeKnownError(
					claim.recordId,
					documentId,
					409,
					blockedError(documentId, error.message),
				);
			}
			throw error;
		}
	},
);

agentSelfSignSigningEndpoint.post(agentSelfSignOperations.complete.relativePath, async (c) => {
	const documentId = parsedUuid(c.req.param("documentId"));
	const parsed = AgentSelfSignCompleteRequestSchema.safeParse(await c.req.json().catch(() => null));
	if (!documentId || !parsed.success) return c.json(invalidCompletionError(), 400);
	const principal = c.get("agenticPrincipal");
	const requestFingerprint = await fingerprintAgentCommand({ documentId, ...parsed.data });
	const priorReview = await inspectHumanReviewCommand({
		principal,
		idempotencyKey: requiredIdempotencyKey(c),
		operation: agentSelfSignOperations.complete.operationId,
		requestFingerprint,
	});
	if (priorReview) return commandClaimResponse(priorReview);
	return queueSigningCompletionReview({
		principal,
		documentId,
		request: parsed.data,
		requestFingerprint,
		idempotencyKey: requiredIdempotencyKey(c),
		operation: agentSelfSignOperations.complete.operationId,
		now: requestNow(c),
		baseUrl: agentEmailDelivery(c).baseUrl,
		emailDelivery: agentEmailDelivery(c),
	});
});

async function claimJsonCommand(
	c: { req: { header: (name: string) => string | undefined } },
	principal: AgenticPrincipal,
	operation: string,
	request: unknown,
) {
	return claimAgentCommand({
		principal,
		idempotencyKey: requiredIdempotencyKey(c),
		operation,
		requestFingerprint: await fingerprintAgentCommand(request),
	});
}

async function recordMutation(
	principal: AgenticPrincipal,
	documentId: string,
	eventType: Parameters<typeof recordAgentDocumentRead>[0]["eventType"],
	c: { req: { header: (name: string) => string | undefined } },
): Promise<void> {
	await recordAgentDocumentRead({ principal, documentId, eventType, requestIp: requestIp(c) });
}

async function completeKnownError(
	recordId: string,
	documentId: string,
	status: number,
	body: unknown,
): Promise<Response> {
	await completeAgentCommand({ recordId, status, body, documentId });
	return Response.json(body, { status });
}

function completeNotFound(recordId: string, documentId: string): Promise<Response> {
	return completeKnownError(recordId, documentId, 404, documentNotFoundError());
}

function completeSigningTaskMissing(recordId: string, documentId: string): Promise<Response> {
	return completeKnownError(recordId, documentId, 404, signingTaskNotFoundError(documentId));
}

function agentEmailDelivery(c: { env?: Env; req: { url: string } }) {
	return {
		env: c.env as EmailDeliveryEnv | undefined,
		baseUrl:
			(c.env as EmailDeliveryEnv | undefined)?.APP_BASE_URL?.trim() || new URL(c.req.url).origin,
	};
}

function completeBlocked(recordId: string, documentId: string, message: string): Promise<Response> {
	return completeKnownError(recordId, documentId, 409, blockedError(documentId, message));
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
		message: "Self-signing task not found",
		retryable: false,
		allowedActions: ["get_document_status"],
		recoveryUrl: `/api/v1/documents/${documentId}/status`,
	});
}

function invalidFieldPlacementError() {
	return agentError({
		code: "INVALID_FIELD_PLACEMENT",
		message: "Use a valid field id, page, x, and y",
		retryable: false,
		allowedActions: ["get_signing_task"],
		recoveryUrl: "/agent.md",
		fields: ["fieldId", "page", "x", "y"],
	});
}

function invalidCompletionError() {
	return agentError({
		code: "INVALID_SIGNING_COMPLETION",
		message: "Use a valid typed or drawn signature",
		retryable: false,
		allowedActions: ["get_signing_task"],
		recoveryUrl: "/agent.md",
		validValues: ["typed", "drawn"],
		fields: ["signature"],
	});
}

function hasReuseConsent(value: unknown): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			"rememberSignature" in value &&
			value.rememberSignature === true,
	);
}

export default agentSelfSignSigningEndpoint;
