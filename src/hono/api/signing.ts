import type { Context } from "hono";
import { z } from "zod";
import {
	ChangeRequestSigningRequestSchema,
	CompleteSigningRequestSchema,
	completeSigning,
	DeclineSigningRequestSchema,
	declineSigning,
	type EmailDeliveryEnv,
	EmailDeliveryError,
	getCompletedDocumentLinkForSignerToken,
	getSignerFinalDocument,
	getSignerSession,
	getSignerSourceDocument,
	getSigningBlockedAllowedActions,
	recordPartnerLinkExpired,
	requestSigningChanges,
	resolveSignerToken,
	SigningChangeRequestError,
	SigningCompletionBlockedError,
	SigningFieldPlacementBlockedError,
	SigningFieldPlacementNotFoundError,
	SigningFinalizationError,
	SigningNoAssignedFieldsError,
	updateSignerFieldPlacement,
	verifyPartnerToken,
} from "@/db/envelope";
import { MAX_SOURCE_PDF_PAGES } from "@/db/envelope/pdf-policy-limits";
import { createHono } from "@/hono/factory";

const signingEndpoint = createHono();

const SigningFieldPlacementRequestSchema = z.object({
	page: z.number().int().min(1).max(MAX_SOURCE_PDF_PAGES).optional(),
	x: z.number().int().min(0),
	y: z.number().int().min(0),
});

signingEndpoint.get("/verifications/:token", async (c) => {
	const accept = c.req.header("accept") ?? "";
	if (accept.includes("text/html")) {
		return c.redirect(`/signing-verifications/${encodeURIComponent(c.req.param("token"))}`);
	}

	const result = await verifyPartnerToken(c.req.param("token"), parseNow(c.req.header("x-now")));
	if (!result.ok) {
		return c.json(
			{
				error: {
					code: result.error.code,
					message: result.error.message,
				},
			},
			result.error.status,
		);
	}

	return c.json({ data: result.data });
});

signingEndpoint.get("/:token/source-pdf", async (c) => {
	const token = await getUsableToken(c.req.param("token"), c.req.header("x-now"));
	if (token instanceof Response) return token;

	const document = await getSignerSourceDocument(token);
	if (!document) {
		return c.json(
			{
				error: {
					code: "SOURCE_PDF_NOT_FOUND",
					message: "Source PDF is not available",
				},
			},
			404,
		);
	}

	const bucket = (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
	const object = await bucket?.get(document.r2Key);
	if (!object) {
		return c.json(
			{
				error: {
					code: "SOURCE_PDF_NOT_FOUND",
					message: "Source PDF is not available",
				},
			},
			404,
		);
	}

	const bytes = await object.arrayBuffer();
	const current = await getUsableToken(token.token, c.req.header("x-now"));
	if (current instanceof Response) return current;
	if (
		current.id !== token.id ||
		current.envelopeId !== token.envelopeId ||
		current.recipientId !== token.recipientId
	)
		return c.json(
			{ error: { code: "SOURCE_PDF_NOT_FOUND", message: "Source PDF is not available" } },
			404,
		);
	return new Response(bytes, {
		headers: { "content-type": document.contentType },
	});
});

signingEndpoint.get("/:token/final-pdf", async (c) => {
	const token = await getUsableToken(c.req.param("token"), c.req.header("x-now"));
	if (token instanceof Response) return token;

	const document = await getSignerFinalDocument(token);
	if (!document) {
		return c.json(
			{
				error: {
					code: "FINAL_PDF_NOT_FOUND",
					message: "Completed PDF is not available",
				},
			},
			404,
		);
	}

	const bucket = (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
	const object = await bucket?.get(document.r2Key);
	if (!object) {
		return c.json(
			{
				error: {
					code: "FINAL_PDF_NOT_FOUND",
					message: "Completed PDF is not available",
				},
			},
			404,
		);
	}

	const bytes = await object.arrayBuffer();
	const current = await getUsableToken(token.token, c.req.header("x-now"));
	if (current instanceof Response) return current;
	if (
		current.id !== token.id ||
		current.envelopeId !== token.envelopeId ||
		current.recipientId !== token.recipientId ||
		current.envelopeStatus !== "completed"
	)
		return c.json(
			{ error: { code: "FINAL_PDF_NOT_FOUND", message: "Completed PDF is not available" } },
			404,
		);
	return new Response(bytes, {
		headers: { "content-type": document.contentType },
	});
});

signingEndpoint.get("/:token", async (c) => {
	const completedDocument = await getCompletedDocumentLinkForSignerToken(c.req.param("token"), {
		now: parseNow(c.req.header("x-now")),
	});
	if (completedDocument) return c.json({ data: { completedDocument } });

	const token = await getUsableToken(c.req.param("token"), c.req.header("x-now"));
	if (token instanceof Response) return token;

	return c.json({ data: await getSignerSession(token) });
});

signingEndpoint.patch("/:token/fields/:fieldId", async (c) => {
	const token = await getUsableToken(c.req.param("token"), c.req.header("x-now"));
	if (token instanceof Response) return token;

	const parsedFieldId = z.string().uuid().safeParse(c.req.param("fieldId"));
	const parsed = SigningFieldPlacementRequestSchema.safeParse(await c.req.json());
	if (!parsedFieldId.success || !parsed.success) {
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
			data: await updateSignerFieldPlacement(token, {
				fieldId: parsedFieldId.data,
				...parsed.data,
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

signingEndpoint.post("/:token/complete", async (c) => {
	const token = await getUsableToken(c.req.param("token"), c.req.header("x-now"), {
		completion: true,
	});
	if (token instanceof Response) return token;

	const parsed = CompleteSigningRequestSchema.safeParse(await c.req.json());
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

	const bucket = (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
	try {
		return c.json({
			data: await completeSigning(token, parsed.data, {
				documentsBucket: bucket,
				now: parseNow(c.req.header("x-now")),
				emailDelivery: getEmailDeliveryOptions(c),
				context: token.completionContext,
			}),
		});
	} catch (error) {
		if (error instanceof SigningFinalizationError) {
			return c.json(
				{
					error: {
						code: error.code,
						message: error.message,
						retryable: true,
						allowedActions: ["retry_completion"],
					},
				},
				503,
			);
		}
		if (error instanceof EmailDeliveryError) {
			return c.json(emailDeliveryErrorBody(error, c.env as EmailDeliveryEnv | undefined), 502);
		}
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

signingEndpoint.post("/:token/change-request", async (c) => {
	const token = await getUsableToken(c.req.param("token"), c.req.header("x-now"));
	if (token instanceof Response) return token;

	const parsed = ChangeRequestSigningRequestSchema.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{
				error: {
					code: "INVALID_CHANGE_REQUEST",
					message: "Change request comment is required",
				},
			},
			400,
		);
	}

	try {
		return c.json({
			data: await requestSigningChanges(token, parsed.data, {
				emailDelivery: getEmailDeliveryOptions(c),
			}),
		});
	} catch (error) {
		if (error instanceof EmailDeliveryError) {
			return c.json(emailDeliveryErrorBody(error, c.env as EmailDeliveryEnv | undefined), 502);
		}
		if (error instanceof SigningChangeRequestError) {
			return c.json(
				{
					error: {
						code: "SIGNING_BLOCKED",
						message: "Envelope is not open for change requests",
					},
				},
				409,
			);
		}
		throw error;
	}
});

signingEndpoint.post("/:token/decline", async (c) => {
	const token = await getUsableToken(c.req.param("token"), c.req.header("x-now"));
	if (token instanceof Response) return token;

	const parsed = DeclineSigningRequestSchema.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{
				error: {
					code: "INVALID_SIGNING_DECLINE",
					message: "Decline reason is required",
				},
			},
			400,
		);
	}

	try {
		return c.json({
			data: await declineSigning(token, parsed.data, { now: parseNow(c.req.header("x-now")) }),
		});
	} catch (error) {
		if (error instanceof SigningCompletionBlockedError)
			return c.json(
				{ error: { code: "SIGNING_BLOCKED", message: "This document can no longer be declined" } },
				409,
			);
		throw error;
	}
});

async function getUsableToken(
	tokenValue: string,
	nowHeader: string | undefined,
	options: { completion?: boolean } = {},
) {
	const token = await resolveSignerToken(tokenValue, options);
	if (!token) {
		return Response.json(
			{
				error: {
					code: "TOKEN_NOT_FOUND",
					message: "Signing token was not found",
				},
			},
			{ status: 404 },
		);
	}

	const now = new Date(nowHeader ?? Date.now());
	const envelopeStatus = token.envelopeStatus;
	if (envelopeStatus === "deleted" || token.deletionPending) {
		return Response.json(
			{
				error: {
					code: "ENVELOPE_DELETED",
					message: "This document was deleted by the sender",
				},
			},
			{ status: 410 },
		);
	}
	if (envelopeStatus === "expired") {
		return Response.json(
			{
				error: {
					code: "ENVELOPE_EXPIRED",
					message: "This signing link is no longer active",
				},
			},
			{ status: 410 },
		);
	}
	if (token.expiresAt <= now) {
		await recordPartnerLinkExpired(token);
		return Response.json(
			{
				error: {
					code: "EXPIRED_TOKEN",
					message: "Signing token has expired",
				},
			},
			{ status: 410 },
		);
	}
	if (!token.verifiedAt) {
		return Response.json(
			{
				error: {
					code: "PARTNER_VERIFICATION_REQUIRED",
					message: "Partner email verification is required before signing",
					verificationUrl: `/signing-verifications/${token.token}`,
				},
			},
			{ status: 403 },
		);
	}

	return token;
}

function parseNow(nowHeader: string | undefined): Date {
	return new Date(nowHeader ?? Date.now());
}

function getEmailDeliveryOptions(c: Context<{ Bindings: Env }>) {
	const env = c.env as EmailDeliveryEnv | undefined;
	const testFallback =
		c.req.header("x-email-delivery-test-bypass") === "true" && env?.CLOUDFLARE_ENV !== "production";
	return {
		env: testFallback ? { ...env, EMAIL_DELIVERY_TEST_BYPASS: "true" } : env,
		baseUrl: getDeliveryBaseUrl(c),
	};
}

function getDeliveryBaseUrl(c: Context<{ Bindings: Env }>): string {
	const env = c.env as EmailDeliveryEnv | undefined;
	return env?.APP_BASE_URL?.trim() || new URL(c.req.url).origin;
}

function emailDeliveryErrorBody(error: EmailDeliveryError, env: EmailDeliveryEnv | undefined) {
	const body: {
		error: {
			code: "EMAIL_DELIVERY_FAILED";
			message: string;
			providerStatus?: number;
			providerMessage?: string;
		};
	} = {
		error: {
			code: "EMAIL_DELIVERY_FAILED",
			message: "Email provider rejected the message",
		},
	};
	if (env?.CLOUDFLARE_ENV !== "production") {
		body.error.providerStatus = error.status;
		body.error.providerMessage = parseProviderMessage(error.responseText);
	}
	return body;
}

function parseProviderMessage(responseText: string): string {
	try {
		const parsed: unknown = JSON.parse(responseText);
		if (parsed && typeof parsed === "object" && "message" in parsed) {
			const message = parsed.message;
			if (typeof message === "string" && message.trim()) return message;
		}
	} catch {
		// Fall back to the raw provider response below.
	}
	return responseText.slice(0, 500);
}

export default signingEndpoint;
