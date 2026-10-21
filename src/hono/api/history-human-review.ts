import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
	authorizeAgentPartnerSigning,
	beginHumanReviewApproval,
	completeHumanReviewApproval,
	failHumanReviewApproval,
	getAuthorizedAgentCreatorEnvelope,
	getHumanReviewDetail,
	getHumanReviewSourceAccess,
	invalidateHumanReviewApproval,
	listPendingHumanReviews,
	recordAgentDocumentRead,
	rejectHumanReview,
} from "@/db/agentic-access";
import {
	AgentCreatorControlRequestSchema,
	AgentCreatorControlResponseSchema,
} from "@/db/agentic-access/creator-controls-schema";
import { AgentPartnerDeclineRequestSchema } from "@/db/agentic-access/partner-signing-schema";
import { AgentSelfSignCompleteRequestSchema } from "@/db/agentic-access/schema";
import {
	controlEnvelope,
	declineSigning,
	type EmailDeliveryEnv,
	EnvelopeControlError,
} from "@/db/envelope";
import {
	recordHistoryEnvelopeSecurityEvent,
	resolveHistorySessionState,
	type VerifiedHistorySession,
} from "@/db/history-access";
import { createHono } from "@/hono/factory";
import { executeAgentSigningCompletion } from "./agent-v1-signing-completion";
import { getRequestIp } from "./envelope-route-helpers";

const historyHumanReviewEndpoint = createHono();
const HumanReviewApprovalSchema = z.object({ decision: z.enum(["approve", "reject"]) });

historyHumanReviewEndpoint.get("/human-reviews", async (c) => {
	const session = await requireHistorySession(c);
	if (session instanceof Response) return session;
	return c.json({ data: { items: await listPendingHumanReviews(session, requestNow(c)) } });
});

historyHumanReviewEndpoint.get("/human-reviews/:reviewId", async (c) => {
	const reviewId = parsedReviewId(c.req.param("reviewId"));
	if (!reviewId) return c.json(humanReviewForbidden(), 404);
	const session = await requireHistorySession(c, reviewId);
	if (session instanceof Response) return session;
	const detail = await getHumanReviewDetail({ session, reviewId });
	if (!detail) return c.json(humanReviewForbidden(), 404);
	await recordHistoryEnvelopeSecurityEvent({
		session,
		envelopeId: detail.document.documentId,
		eventType: "human_review.opened",
		requestIp: requestIp(c),
	});
	return c.json({ data: detail });
});

historyHumanReviewEndpoint.get("/human-reviews/:reviewId/source-pdf", async (c) => {
	const reviewId = parsedReviewId(c.req.param("reviewId"));
	if (!reviewId) return c.json(humanReviewForbidden(), 404);
	const session = await requireHistorySession(c, reviewId);
	if (session instanceof Response) return session;
	const access = await getHumanReviewSourceAccess({ session, reviewId });
	const bucket = (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
	const object = access && bucket ? await bucket.get(access.r2Key) : null;
	if (!access || !object) return c.json(humanReviewForbidden(), 404);
	await recordHistoryEnvelopeSecurityEvent({
		session,
		envelopeId: access.documentId,
		eventType: "human_review.source_pdf_opened",
		requestIp: requestIp(c),
	});
	return new Response(await object.arrayBuffer(), {
		headers: { "content-type": access.contentType },
	});
});

historyHumanReviewEndpoint.post("/human-reviews/:reviewId/decision", async (c) => {
	if (c.req.header("origin") !== new URL(c.req.url).origin) {
		return c.json(
			{ error: { code: "INVALID_ORIGIN", message: "Use Signmos to review this request" } },
			403,
		);
	}
	const reviewId = parsedReviewId(c.req.param("reviewId"));
	const parsed = HumanReviewApprovalSchema.safeParse(await c.req.json().catch(() => null));
	if (!reviewId || !parsed.success) return c.json(humanReviewForbidden(), 404);
	const session = await requireHistorySession(c, reviewId);
	if (session instanceof Response) return session;
	return decideHumanReview(c, session, reviewId, parsed.data.decision);
});

type ReadyApproval = Extract<
	Awaited<ReturnType<typeof beginHumanReviewApproval>>,
	{ state: "ready" }
>;

async function decideHumanReview(
	c: Context<{ Bindings: Env }>,
	session: VerifiedHistorySession,
	reviewId: string,
	decision: "approve" | "reject",
) {
	if (decision === "reject") return rejectReview(c, session, reviewId);
	const approval = await beginHumanReviewApproval({ reviewId, session, now: requestNow(c) });
	if (approval.state !== "ready") return decisionError(c, approval.state);
	await recordHumanApprovalAudit(c, session, approval.documentId);
	try {
		if (approval.operation === "declineAgentSigning") {
			return await executeDeclineApproval(c, session, approval);
		}
		if (approval.operation === "controlAgentDocument") {
			return await executeControlApproval(c, session, approval);
		}
		return await executeSigningApproval(c, session, approval);
	} catch {
		return failReadyApproval(c, session, approval);
	}
}

async function rejectReview(
	c: Context<{ Bindings: Env }>,
	session: VerifiedHistorySession,
	reviewId: string,
) {
	const rejection = await rejectHumanReview({ reviewId, session, now: requestNow(c) });
	if (rejection.state !== "rejected") return decisionError(c, rejection.state);
	await recordHistoryEnvelopeSecurityEvent({
		session,
		envelopeId: rejection.documentId,
		eventType: "human_review.rejected",
		requestIp: requestIp(c),
	});
	return c.json(rejection.body);
}

async function executeDeclineApproval(
	c: Context<{ Bindings: Env }>,
	session: VerifiedHistorySession,
	approval: ReadyApproval,
) {
	const payload = AgentPartnerDeclineRequestSchema.safeParse(approval.actionPayload);
	const authorization = await authorizeAgentPartnerSigning(approval.principal, approval.documentId);
	if (!payload.success || authorization.state !== "active") {
		return invalidateReadyApproval(c, approval, "SIGNER_AUTHORITY_CHANGED");
	}
	const result = await declineSigning(authorization.token, payload.data);
	await recordAgentDocumentRead({
		principal: approval.principal,
		documentId: approval.documentId,
		eventType: "agentic.partner.declined",
		requestIp: requestIp(c),
	});
	return persistExecution(c, session, approval, result);
}

async function executeControlApproval(
	c: Context<{ Bindings: Env }>,
	session: VerifiedHistorySession,
	approval: ReadyApproval,
) {
	const payload = AgentCreatorControlRequestSchema.safeParse(approval.actionPayload);
	const envelope = await getAuthorizedAgentCreatorEnvelope(approval.principal, approval.documentId);
	if (!payload.success || !envelope) {
		return invalidateReadyApproval(c, approval, "CREATOR_AUTHORITY_CHANGED");
	}
	let result: Awaited<ReturnType<typeof controlEnvelope>>;
	try {
		result = await controlEnvelope(
			approval.documentId,
			approval.principal.email,
			payload.data.action,
			{ documentsBucket: documentsBucket(c) },
		);
	} catch (error) {
		if (error instanceof EnvelopeControlError) {
			return invalidateReadyApproval(c, approval, "DOCUMENT_LIFECYCLE_CHANGED");
		}
		throw error;
	}
	const body = AgentCreatorControlResponseSchema.parse({ data: result });
	await recordAgentDocumentRead({
		principal: approval.principal,
		documentId: approval.documentId,
		eventType: creatorControlAuditEvent(payload.data.action),
		requestIp: requestIp(c),
	});
	return persistExecution(c, session, approval, body.data);
}

async function executeSigningApproval(
	c: Context<{ Bindings: Env }>,
	session: VerifiedHistorySession,
	approval: ReadyApproval,
) {
	if (approval.operation !== "completeAgentSigning") {
		return invalidateReadyApproval(c, approval, "OPERATION_CHANGED");
	}
	const payload = AgentSelfSignCompleteRequestSchema.safeParse(approval.actionPayload);
	if (!payload.success) return invalidateReadyApproval(c, approval, "PAYLOAD_CHANGED");
	const execution = await executeAgentSigningCompletion({
		principal: approval.principal,
		documentId: approval.documentId,
		request: payload.data,
		now: requestNow(c),
		requestIp: requestIp(c),
		documentsBucket: documentsBucket(c),
		emailDelivery: humanReviewEmailDelivery(c),
	});
	if (!execution.ok)
		return execution.status >= 500
			? failReadyApproval(c, session, approval)
			: invalidateReadyApproval(c, approval, "DOCUMENT_LIFECYCLE_CHANGED");
	const executionBody = (await execution.json()) as { data?: unknown };
	if (executionBody.data === undefined) {
		return invalidateReadyApproval(c, approval, "EXECUTION_RESULT_INVALID");
	}
	return persistExecution(c, session, approval, executionBody.data);
}

async function persistExecution(
	c: Context<{ Bindings: Env }>,
	session: VerifiedHistorySession,
	approval: ReadyApproval,
	result: unknown,
) {
	const terminal = await completeHumanReviewApproval({
		commandId: approval.commandId,
		notificationStatus: approval.notificationStatus,
		result,
		now: requestNow(c),
	});
	await recordHumanExecutionAudit(c, session, approval.documentId);
	return c.json(terminal);
}

async function failReadyApproval(
	c: Context<{ Bindings: Env }>,
	session: VerifiedHistorySession,
	approval: ReadyApproval,
) {
	const terminal = await failHumanReviewApproval({
		commandId: approval.commandId,
		documentId: approval.documentId,
		notificationStatus: approval.notificationStatus,
		now: requestNow(c),
	});
	await recordHistoryEnvelopeSecurityEvent({
		session,
		envelopeId: approval.documentId,
		eventType: "human_review.execution_failed",
		requestIp: requestIp(c),
	});
	return c.json(terminal);
}

function recordHumanApprovalAudit(
	c: Context<{ Bindings: Env }>,
	session: VerifiedHistorySession,
	documentId: string,
) {
	return recordHistoryEnvelopeSecurityEvent({
		session,
		envelopeId: documentId,
		eventType: "human_review.approved",
		requestIp: requestIp(c),
	});
}

async function invalidateReadyApproval(
	c: Context<{ Bindings: Env }>,
	approval: Extract<Awaited<ReturnType<typeof beginHumanReviewApproval>>, { state: "ready" }>,
	reason: string,
) {
	await invalidateHumanReviewApproval({
		commandId: approval.commandId,
		documentId: approval.documentId,
		notificationStatus: approval.notificationStatus,
		now: requestNow(c),
		reason,
	});
	return decisionError(c, "invalidated");
}

function recordHumanExecutionAudit(
	c: Context<{ Bindings: Env }>,
	session: VerifiedHistorySession,
	documentId: string,
) {
	return recordHistoryEnvelopeSecurityEvent({
		session,
		envelopeId: documentId,
		eventType: "human_review.executed",
		requestIp: requestIp(c),
	});
}

async function requireHistorySession(
	c: Context<{ Bindings: Env }>,
	reviewId?: string,
): Promise<VerifiedHistorySession | Response> {
	const state = await resolveHistorySessionState(
		getCookie(c, "signmos_history_session") ?? "",
		requestNow(c),
		requestIp(c),
	);
	if (state.state === "active") return state.session;
	const recoveryUrl = reviewId
		? `/?task=my-documents&returnTo=${encodeURIComponent(`/human-review/${reviewId}`)}`
		: "/?task=my-documents";
	return Response.json(
		{
			error: {
				code: state.state === "expired" ? "HISTORY_SESSION_EXPIRED" : "HISTORY_SESSION_REQUIRED",
				message: "Verify the reviewer's email in My documents to continue",
				recoveryUrl,
			},
		},
		{ status: 401 },
	);
}

function humanReviewForbidden() {
	return {
		error: {
			code: "HUMAN_REVIEW_FORBIDDEN",
			message: "This review is not available",
			recoveryUrl: "/?task=my-documents",
		},
	};
}

function decisionError(
	c: Context<{ Bindings: Env }>,
	state: "forbidden" | "expired" | "invalidated" | "already_decided",
) {
	const errors = {
		forbidden: ["HUMAN_REVIEW_FORBIDDEN", "This review is not available", 404],
		expired: ["HUMAN_REVIEW_EXPIRED", "This review request expired", 410],
		invalidated: ["HUMAN_REVIEW_INVALIDATED", "This review request is no longer valid", 409],
		already_decided: ["HUMAN_REVIEW_ALREADY_DECIDED", "This review was already decided", 409],
	} as const;
	const [code, message, status] = errors[state];
	return c.json({ error: { code, message, recoveryUrl: "/my-documents" } }, status);
}

function parsedReviewId(value: string | undefined): string | null {
	return value && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? value : null;
}

function requestNow(c: Context<{ Bindings: Env }>): Date {
	if ((c.env as { CLOUDFLARE_ENV?: string } | undefined)?.CLOUDFLARE_ENV === "production") {
		return new Date();
	}
	return new Date(c.req.header("x-now") ?? Date.now());
}

function requestIp(c: Context<{ Bindings: Env }>): string {
	return getRequestIp(c.req.header("cf-connecting-ip"), c.req.header("x-forwarded-for"));
}

function humanReviewEmailDelivery(c: Context<{ Bindings: Env }>) {
	return {
		env: c.env as EmailDeliveryEnv | undefined,
		baseUrl:
			(c.env as EmailDeliveryEnv | undefined)?.APP_BASE_URL?.trim() || new URL(c.req.url).origin,
	};
}

function documentsBucket(c: Context<{ Bindings: Env }>): R2Bucket | undefined {
	return (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
}

function creatorControlAuditEvent(action: "cancel" | "expire" | "delete") {
	if (action === "cancel") return "agentic.document.canceled" as const;
	if (action === "expire") return "agentic.document.expired" as const;
	return "agentic.document.deleted" as const;
}

export default historyHumanReviewEndpoint;
