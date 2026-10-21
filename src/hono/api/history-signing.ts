import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
	ChangeRequestSigningRequestSchema,
	CompleteSigningRequestSchema,
	completeSigning,
	DeclineSigningRequestSchema,
	declineSigning,
	type EmailDeliveryEnv,
	EmailDeliveryError,
	getSignerSession,
	getSignerSourceDocument,
	getSigningBlockedAllowedActions,
	requestSigningChanges,
	SigningChangeRequestError,
	SigningCompletionBlockedError,
	SigningFieldPlacementBlockedError,
	SigningFieldPlacementNotFoundError,
	SigningNoAssignedFieldsError,
	updateSignerFieldPlacement,
} from "@/db/envelope";
import { MAX_SOURCE_PDF_PAGES } from "@/db/envelope/pdf-policy-limits";
import {
	authorizeHistorySigner,
	getHistoryCompletedDocumentView,
	recordHistorySignerAudit,
	resolveHistorySessionState,
	type VerifiedHistorySession,
} from "@/db/history-access";
import { createHono } from "@/hono/factory";
import { getRequestIp } from "./envelope-route-helpers";
import { historyError } from "./history-errors";

const historySigningEndpoint = createHono();
const HistorySigningFieldPlacementSchema = z.object({
	page: z.number().int().min(1).max(MAX_SOURCE_PDF_PAGES).optional(),
	x: z.number().int().min(0),
	y: z.number().int().min(0),
});

historySigningEndpoint.get("/documents/:envelopeId/signing", async (c) => {
	const session = await requireHistorySession(c);
	if (session instanceof Response) return session;
	const envelopeId = c.req.param("envelopeId");
	const authorization = await authorizeHistorySigner(session.email, envelopeId, requestNow(c));
	if (authorization.state === "completed") {
		const view = await getHistoryCompletedDocumentView(session.email, envelopeId, requestNow(c));
		if (!view) return historySigningError(authorization);
		return c.json({
			data: {
				completedDocument: {
					url: `/my-documents/${envelopeId}`,
					downloadUrl: `/api/history/documents/${envelopeId}/pdf`,
				},
			},
		});
	}
	if (authorization.state !== "active") return historySigningError(authorization);
	return c.json({
		data: await getSignerSession(authorization.token, {
			sourceDownloadUrl: `/api/history/documents/${envelopeId}/signing/source-pdf`,
		}),
	});
});

historySigningEndpoint.get("/documents/:envelopeId/signing/source-pdf", async (c) => {
	const context = await requireActiveHistorySigner(c);
	if (context instanceof Response) return context;
	const document = await getSignerSourceDocument(context.token);
	const bucket = (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
	const object = document ? await bucket?.get(document.r2Key) : null;
	if (!document || !object) {
		return c.json(
			{ error: { code: "SOURCE_PDF_NOT_FOUND", message: "Source PDF is not available" } },
			404,
		);
	}
	await recordHistorySignerAudit({
		session: context.session,
		envelopeId: context.token.envelopeId,
		eventType: "history.signer.source_pdf.opened",
		requestIp: requestIp(c),
	});
	return new Response(await object.arrayBuffer(), {
		headers: { "content-type": document.contentType },
	});
});

historySigningEndpoint.patch("/documents/:envelopeId/signing/fields/:fieldId", async (c) => {
	const originError = requireSameOrigin(c);
	if (originError) return originError;
	const context = await requireActiveHistorySigner(c);
	if (context instanceof Response) return context;
	const fieldId = z.string().uuid().safeParse(c.req.param("fieldId"));
	const placement = HistorySigningFieldPlacementSchema.safeParse(
		await c.req.json().catch(() => null),
	);
	if (!fieldId.success || !placement.success) {
		return c.json(
			{
				error: {
					code: "INVALID_FIELD_PLACEMENT",
					message: "Field placement must use a valid field id, page, x, and y",
				},
			},
			400,
		);
	}
	try {
		return c.json({
			data: await updateSignerFieldPlacement(context.token, {
				fieldId: fieldId.data,
				...placement.data,
			}),
		});
	} catch (error) {
		if (error instanceof SigningFieldPlacementNotFoundError) {
			return c.json(
				{ error: { code: "FIELD_NOT_FOUND", message: "Signing field was not found" } },
				404,
			);
		}
		if (error instanceof SigningFieldPlacementBlockedError) {
			return c.json(
				{
					error: {
						code: "FIELD_PLACEMENT_BLOCKED",
						message: "Only self-sign envelopes can reposition signing fields",
					},
				},
				409,
			);
		}
		throw error;
	}
});

historySigningEndpoint.post("/documents/:envelopeId/signing/complete", async (c) => {
	const originError = requireSameOrigin(c);
	if (originError) return originError;
	const context = await requireActiveHistorySigner(c);
	if (context instanceof Response) return context;
	const parsed = CompleteSigningRequestSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json(
			{
				error: {
					code: "INVALID_SIGNING_COMPLETION",
					message: "Signature and signing date are required",
				},
			},
			400,
		);
	}
	try {
		const result = await completeSigning(context.token, parsed.data, {
			documentsBucket: (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)
				?.DOCUMENTS_BUCKET,
			now: requestNow(c),
			emailDelivery: historyEmailDelivery(c),
		});
		await recordHistorySignerAudit({
			session: context.session,
			envelopeId: context.token.envelopeId,
			eventType: "history.signer.completed",
			requestIp: requestIp(c),
		});
		return c.json({ data: result });
	} catch (error) {
		if (error instanceof EmailDeliveryError) return historyEmailDeliveryError(c, error);
		if (error instanceof SigningCompletionBlockedError) {
			return c.json(
				{
					error: {
						code: "SIGNING_BLOCKED",
						message: "Envelope is waiting for sender revision",
						allowedActions: getSigningBlockedAllowedActions(error.status),
					},
				},
				409,
			);
		}
		if (error instanceof SigningNoAssignedFieldsError) {
			return c.json(
				{
					error: {
						code: "NO_ASSIGNED_FIELDS",
						message: "No signing fields are assigned to this recipient",
						allowedActions: ["request_changes"],
					},
				},
				409,
			);
		}
		throw error;
	}
});

historySigningEndpoint.post("/documents/:envelopeId/signing/change-request", async (c) => {
	const originError = requireSameOrigin(c);
	if (originError) return originError;
	const context = await requireActiveHistorySigner(c);
	if (context instanceof Response) return context;
	const parsed = ChangeRequestSigningRequestSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json(
			{ error: { code: "INVALID_CHANGE_REQUEST", message: "Change request comment is required" } },
			400,
		);
	}
	try {
		const result = await requestSigningChanges(context.token, parsed.data, {
			emailDelivery: historyEmailDelivery(c),
		});
		await recordHistorySignerAudit({
			session: context.session,
			envelopeId: context.token.envelopeId,
			eventType: "history.signer.change_requested",
			requestIp: requestIp(c),
		});
		return c.json({ data: result });
	} catch (error) {
		if (error instanceof EmailDeliveryError) return historyEmailDeliveryError(c, error);
		if (error instanceof SigningChangeRequestError) {
			return c.json(
				{ error: { code: "SIGNING_BLOCKED", message: "Envelope is not open for change requests" } },
				409,
			);
		}
		throw error;
	}
});

historySigningEndpoint.post("/documents/:envelopeId/signing/decline", async (c) => {
	const originError = requireSameOrigin(c);
	if (originError) return originError;
	const context = await requireActiveHistorySigner(c);
	if (context instanceof Response) return context;
	const parsed = DeclineSigningRequestSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json(
			{ error: { code: "INVALID_SIGNING_DECLINE", message: "Decline reason is required" } },
			400,
		);
	}
	const result = await declineSigning(context.token, parsed.data);
	await recordHistorySignerAudit({
		session: context.session,
		envelopeId: context.token.envelopeId,
		eventType: "history.signer.declined",
		requestIp: requestIp(c),
	});
	return c.json({ data: result });
});

async function requireActiveHistorySigner(c: Context<{ Bindings: Env }>) {
	const session = await requireHistorySession(c);
	if (session instanceof Response) return session;
	const envelopeId = c.req.param("envelopeId");
	if (!envelopeId) {
		return Response.json(historyError("HISTORY_SIGNING_NOT_FOUND"), { status: 404 });
	}
	const authorization = await authorizeHistorySigner(session.email, envelopeId, requestNow(c));
	return authorization.state === "active"
		? { session, token: authorization.token }
		: historySigningError(authorization);
}

async function requireHistorySession(
	c: Context<{ Bindings: Env }>,
): Promise<VerifiedHistorySession | Response> {
	const state = await resolveHistorySessionState(
		getCookie(c, "signmos_history_session") ?? "",
		requestNow(c),
		getRequestIp(c.req.header("cf-connecting-ip"), c.req.header("x-forwarded-for")),
	);
	if (state.state === "active") return state.session;
	const expired = state.state === "expired";
	return Response.json(
		historyError(expired ? "HISTORY_SESSION_EXPIRED" : "HISTORY_SESSION_REQUIRED"),
		{ status: 401 },
	);
}

function historySigningError(
	authorization: Exclude<Awaited<ReturnType<typeof authorizeHistorySigner>>, { state: "active" }>,
): Response {
	if (authorization.state === "terminal") {
		const codes = {
			declined: "HISTORY_SIGNING_DECLINED",
			expired: "HISTORY_SIGNING_EXPIRED",
			deleted: "HISTORY_SIGNING_DELETED",
		} as const;
		return Response.json(historyError(codes[authorization.status]), { status: 410 });
	}
	if (authorization.state === "inactive" || authorization.state === "completed") {
		return Response.json(historyError("HISTORY_SIGNING_NOT_ACTIVE"), { status: 409 });
	}
	return Response.json(historyError("HISTORY_SIGNING_NOT_FOUND"), { status: 404 });
}

function requireSameOrigin(c: Context<{ Bindings: Env }>): Response | null {
	if (c.req.header("origin") === new URL(c.req.url).origin) return null;
	return Response.json(
		{ error: { code: "INVALID_ORIGIN", message: "Use My documents to sign" } },
		{ status: 403 },
	);
}

function requestNow(c: Context<{ Bindings: Env }>): Date {
	return new Date(c.req.header("x-now") ?? Date.now());
}

function requestIp(c: Context<{ Bindings: Env }>): string {
	return getRequestIp(c.req.header("cf-connecting-ip"), c.req.header("x-forwarded-for"));
}

function historyEmailDelivery(c: Context<{ Bindings: Env }>) {
	return {
		env: c.env as EmailDeliveryEnv | undefined,
		baseUrl:
			(c.env as EmailDeliveryEnv | undefined)?.APP_BASE_URL?.trim() || new URL(c.req.url).origin,
	};
}

function historyEmailDeliveryError(c: Context<{ Bindings: Env }>, error: EmailDeliveryError) {
	const env = c.env as EmailDeliveryEnv | undefined;
	return c.json(
		{
			error: {
				code: "EMAIL_DELIVERY_FAILED",
				message: "Email provider rejected the message",
				...(env?.CLOUDFLARE_ENV === "production"
					? {}
					: { providerStatus: error.status, providerMessage: error.responseText.slice(0, 500) }),
			},
		},
		502,
	);
}

export default historySigningEndpoint;
