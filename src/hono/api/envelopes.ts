import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import {
	AddFieldsRequestSchema,
	AddRecipientsRequestSchema,
	addFields,
	addRecipients,
	controlEnvelope,
	createEnvelope,
	deleteRecipient,
	type EmailDeliveryEnv,
	EmailDeliveryError,
	EnvelopeActionRequestSchema,
	EnvelopeControlError,
	envelopeLifecycleActions,
	getDocumentHistoryForEmail,
	getEnvelopeAllowedActions,
	getEnvelopeCreatorEmail,
	getEnvelopeFinalizationStatus,
	getEnvelopeRetentionStatus,
	getFinalDocument,
	getLatestSourcePdfDocument,
	getSelfSignPreparation,
	listEnvelopeFields,
	listRecipients,
	prepareSelfSignAfterSourceUpload,
	RecipientCreateSchema,
	recordSourcePdfUploadRejection,
	resendInvitation,
	resolveVerifiedSenderIdentity,
	resolveVerifiedSenderSession,
	SenderStartRateLimitError,
	SenderStartRequestSchema,
	type SenderStartResponse,
	SignaturePlaceholderLimitError,
	SourcePdfUploadError,
	sendEnvelope,
	startSenderEnvelope,
	toEnvelopeFieldResponse,
	toEnvelopeResponse,
	toRecipientResponse,
	toSourceDocumentResponse,
	updateRecipient,
	uploadSourcePdfDocument,
	type VerifiedSenderSession,
	verifySenderToken,
} from "@/db/envelope";
import { MAX_SOURCE_PDF_BYTES, PdfPolicyError } from "@/db/envelope/pdf-policy";
import {
	authorizeHistoryCreator,
	type HistoryCreatorAccess,
	resolveHistorySessionState,
} from "@/db/history-access";
import { createHono } from "@/hono/factory";
import {
	detectPdfLastPage,
	getRequestIp,
	getVerifiedSenderUploadEmail,
	isPdf,
	parseNow,
	parseSourceFilename,
	type SenderStartEnv,
	sha256Hex,
	verifyTurnstileToken,
} from "./envelope-route-helpers";
import { historyError } from "./history-errors";

const envelopesEndpoint = createHono();
const maxSourcePdfBytes = MAX_SOURCE_PDF_BYTES;

envelopesEndpoint.use("/:id/*", async (c, next) => {
	if (!isHistoryCreatorRequest(c)) return next();
	const state = await resolveHistorySessionState(
		getCookie(c, "signmos_history_session") ?? "",
		parseNow(c.req.header("x-now")),
		getRequestIp(c.req.header("cf-connecting-ip"), c.req.header("x-forwarded-for")),
	);
	if (state.state !== "active") {
		return c.json(
			historyError(
				state.state === "expired" ? "HISTORY_SESSION_EXPIRED" : "HISTORY_SESSION_REQUIRED",
			),
			401,
		);
	}
	const authorization = await authorizeHistoryCreator(
		state.session.email,
		c.req.param("id"),
		parseNow(c.req.header("x-now")),
	);
	if (authorization.state === "deleted") {
		return c.json(historyError("HISTORY_CREATOR_DELETED"), 410);
	}
	if (authorization.state === "forbidden") {
		return c.json(historyError("HISTORY_CREATOR_FORBIDDEN"), 403);
	}
	return next();
});
envelopesEndpoint.post("/sender-start", async (c) => {
	const body: unknown = await c.req.json().catch(() => null);
	const parsed = SenderStartRequestSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{
				error: {
					code: "INVALID_SENDER_START",
					message: "Sender name, email, and Turnstile token are required",
					fields: ["name", "email", "turnstileToken"],
				},
			},
			400,
		);
	}

	const requestIp = getRequestIp(c.req.header("cf-connecting-ip"), c.req.header("x-forwarded-for"));
	const turnstilePassed = await verifyTurnstileToken({
		env: (c.env ?? {}) as SenderStartEnv,
		token: parsed.data.turnstileToken,
		ip: requestIp,
	});
	if (!turnstilePassed) {
		return c.json(
			{
				error: {
					code: "TURNSTILE_FAILED",
					message: "Turnstile verification failed",
				},
			},
			403,
		);
	}

	try {
		const result = await startSenderEnvelope({
			signingMode: parsed.data.signingMode,
			name: parsed.data.name,
			email: parsed.data.email,
			requestIp,
			baseUrl: getDeliveryBaseUrl(c),
			idempotencyKey: c.req.header("idempotency-key") ?? undefined,
			now: parseNow(c.req.header("x-now")),
			emailDelivery: getEmailDeliveryOptions(c),
		});
		return c.json(senderStartResponseBody(result.response, c), result.reused ? 200 : 201);
	} catch (error) {
		if (error instanceof EmailDeliveryError) {
			return c.json(emailDeliveryErrorBody(error, c.env as EmailDeliveryEnv | undefined), 502);
		}
		if (error instanceof SenderStartRateLimitError) {
			return c.json(
				{
					error: {
						code: "RATE_LIMITED",
						message: "Too many sender start attempts",
						scope: error.scope,
						resetAt: error.resetAt.toISOString(),
					},
				},
				429,
			);
		}
		throw error;
	}
});

type PublicSenderStartResponse = Omit<SenderStartResponse, "verification"> & {
	verification: Omit<SenderStartResponse["verification"], "fallbackUrl">;
};

type SenderStartResponseBody = {
	data: PublicSenderStartResponse;
	debug?: {
		senderVerificationUrl: string;
	};
};

type SenderStartDebugEnv = SenderStartEnv & {
	CLOUDFLARE_ENV?: string;
	SENDER_VERIFICATION_DEBUG_LINKS?: string;
};

function senderStartResponseBody(
	response: SenderStartResponse,
	c: Context,
): SenderStartResponseBody {
	const body: SenderStartResponseBody = { data: toPublicSenderStartResponse(response) };
	if (shouldExposeSenderVerificationDebug(c)) {
		body.debug = { senderVerificationUrl: response.verification.fallbackUrl };
	}
	return body;
}

function toPublicSenderStartResponse(response: SenderStartResponse): PublicSenderStartResponse {
	const { fallbackUrl: _fallbackUrl, ...verification } = response.verification;
	return { ...response, verification };
}

function shouldExposeSenderVerificationDebug(c: Context): boolean {
	if (c.req.header("x-signmos-debug") !== "sender-verification-link") return false;
	const env = (c.env ?? {}) as SenderStartDebugEnv;
	if (env.CLOUDFLARE_ENV === "production") return false;
	return (
		env.CLOUDFLARE_ENV === "dev" ||
		env.CLOUDFLARE_ENV === "development" ||
		env.CLOUDFLARE_ENV === "test" ||
		env.TURNSTILE_TEST_BYPASS === "true" ||
		env.SENDER_VERIFICATION_DEBUG_LINKS === "true"
	);
}

envelopesEndpoint.get("/sender-verifications/:token", async (c) => {
	const accept = c.req.header("accept") ?? "";
	if (accept.includes("text/html")) {
		return c.redirect(`/sender-verifications/${encodeURIComponent(c.req.param("token"))}`);
	}

	const result = await verifySenderToken(c.req.param("token"), parseNow(c.req.header("x-now")));
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

envelopesEndpoint.get("/:id/sender-session", async (c) => {
	const session = await resolveVerifiedSenderSession(
		c.req.header("x-sender-session-token") ?? c.req.query("senderSessionToken") ?? "",
		c.req.param("id"),
		parseNow(c.req.header("x-now")),
	);
	if (!session) {
		return c.json(
			{
				error: {
					code: "SENDER_SESSION_FORBIDDEN",
					message: "Verified sender access is required",
				},
			},
			403,
		);
	}

	return c.json({
		data: {
			envelopeId: session.envelopeId,
			sender: {
				name: session.name,
				email: session.email,
			},
		},
	});
});

envelopesEndpoint.post("/", async (c) => {
	const createdBy = c.req.header("x-internal-user-id");
	if (!createdBy) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const result = await createEnvelope({
		createdBy,
		idempotencyKey: c.req.header("idempotency-key") ?? undefined,
	});

	return c.json({ data: toEnvelopeResponse(result.envelope) }, result.reused ? 200 : 201);
});

envelopesEndpoint.post("/:id/actions", async (c) => {
	const body = await c.req.json();
	const parsed = EnvelopeActionRequestSchema.safeParse(body);
	if (!parsed.success) {
		return invalidActionResponse(c);
	}

	const envelopeId = c.req.param("id");
	const actor =
		parsed.data.action === "send"
			? await getEnvelopeActor(c, envelopeId)
			: await getEnvelopeControlActor(c, envelopeId);
	if (actor instanceof Response) return actor;
	const sentBy = actor;
	if (!sentBy) return unauthorizedResponse(c);
	if (parsed.data.action === "send") return sendEnvelopeAction(c, envelopeId, sentBy);
	return controlEnvelopeAction(c, envelopeId, sentBy, parsed.data.action);
});

function invalidActionResponse(c: Context<{ Bindings: Env }>) {
	return c.json(
		{
			error: {
				code: "INVALID_ACTION",
				message: "Invalid envelope lifecycle action",
				validValues: [...envelopeLifecycleActions],
			},
		},
		400,
	);
}

function unauthorizedResponse(c: Context<{ Bindings: Env }>) {
	return c.json(
		{
			error: {
				code: "UNAUTHORIZED",
				message: "Missing x-internal-user-id header",
			},
		},
		401,
	);
}

async function sendEnvelopeAction(
	c: Context<{ Bindings: Env }>,
	envelopeId: string,
	sentBy: string,
) {
	try {
		const result = await sendEnvelope(envelopeId, sentBy, {
			emailDelivery: getEmailDeliveryOptions(c),
		});
		return c.json({ data: result });
	} catch (error) {
		if (error instanceof EmailDeliveryError) {
			return c.json(emailDeliveryErrorBody(error, c.env as EmailDeliveryEnv | undefined), 502);
		}
		const sendPrecondition = sendPreconditionErrorBody(error);
		if (sendPrecondition) return c.json(sendPrecondition, 409);
		throw error;
	}
}

async function controlEnvelopeAction(
	c: Context<{ Bindings: Env }>,
	envelopeId: string,
	sentBy: string,
	action: Exclude<(typeof envelopeLifecycleActions)[number], "send">,
) {
	try {
		const bucket = (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
		const result = await controlEnvelope(envelopeId, sentBy, action, {
			documentsBucket: bucket,
		});
		return c.json({ data: result });
	} catch (error) {
		if (error instanceof EnvelopeControlError) {
			return c.json(
				{
					error: {
						code: error.code,
						message: "Envelope action is not allowed in the current state",
						allowedActions: error.allowedActions,
					},
				},
				409,
			);
		}
		throw error;
	}
}

envelopesEndpoint.get("/:id/status", async (c) => {
	const result = await getEnvelopeFinalizationStatus(c.req.param("id"));
	return c.json({ data: result });
});

envelopesEndpoint.get("/:id/retention", async (c) => {
	const userId = c.req.header("x-internal-user-id");
	if (!userId) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const result = await getEnvelopeRetentionStatus(
		c.req.param("id"),
		parseNow(c.req.header("x-now")),
	);
	return c.json({ data: result });
});

envelopesEndpoint.get("/:id/history", async (c) => {
	const envelopeId = c.req.param("id");
	const now = parseNow(c.req.header("x-now"));
	const senderSession = await resolveVerifiedSenderSession(
		c.req.header("x-sender-session-token") ?? c.req.query("senderSessionToken") ?? "",
		envelopeId,
		now,
	);
	if (!senderSession) {
		return c.json(
			{
				error: {
					code: "HISTORY_FORBIDDEN",
					message: "Verified sender access is required before viewing document history",
				},
			},
			403,
		);
	}

	const history = await getDocumentHistoryForEmail({
		email: senderSession.email,
		senderSessionToken: senderSession.token,
		now,
	});
	return c.json({ data: history });
});

envelopesEndpoint.get("/:id/final-pdf", async (c) => {
	const envelopeId = c.req.param("id");
	const senderSessionToken =
		c.req.query("senderSessionToken") ?? c.req.header("x-sender-session-token");
	const senderSession = senderSessionToken
		? await resolveVerifiedSenderSession(
				senderSessionToken,
				envelopeId,
				parseNow(c.req.header("x-now")),
			)
		: null;
	if (!senderSession) {
		return c.json(
			{
				error: {
					code: "FINAL_PDF_FORBIDDEN",
					message: "Verified sender access is required",
				},
			},
			403,
		);
	}

	const document = await getFinalDocument(envelopeId);
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

	const bucket = (c.env as Env & { DOCUMENTS_BUCKET: R2Bucket }).DOCUMENTS_BUCKET;
	const object = await bucket.get(document.r2Key);
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

	return new Response(await object.arrayBuffer(), {
		headers: { "content-type": document.contentType },
	});
});

envelopesEndpoint.get("/:id/source-pdf", async (c) => {
	const userId = await getEnvelopeActor(c, c.req.param("id"));
	if (!userId) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const document = await getLatestSourcePdfDocument(c.req.param("id"));
	if (!document) {
		return c.json(sourcePdfMissingBody(), 404);
	}

	return c.json({
		data: {
			...toSourceDocumentResponse(document),
			...(await sourcePdfSelfSignResponse(c.req.param("id"))),
		},
	});
});

envelopesEndpoint.get("/:id/source-pdf/content", async (c) => {
	const userId = await getEnvelopeActor(c, c.req.param("id"));
	if (!userId) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const document = await getLatestSourcePdfDocument(c.req.param("id"));
	if (!document) {
		return c.json(sourcePdfMissingBody(), 404);
	}

	const bucket = (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
	const object = await bucket?.get(document.r2Key);
	if (!object) {
		return c.json(sourcePdfMissingBody(), 404);
	}

	return new Response(await object.arrayBuffer(), {
		headers: {
			"cache-control": "no-store",
			"content-disposition": "inline",
			"content-type": document.contentType,
		},
	});
});

envelopesEndpoint.post("/:id/source-pdf", async (c) => {
	const envelopeId = c.req.param("id");
	const now = parseNow(c.req.header("x-now"));
	const uploadActor = await getSourcePdfUploadActor(c, envelopeId, now);
	if (!uploadActor) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const contentType = c.req.header("content-type")?.split(";")[0]?.trim() ?? "";
	const bytes = new Uint8Array(await c.req.arrayBuffer());
	if (contentType !== "application/pdf" || !isPdf(bytes)) {
		await recordSourcePdfUploadRejection({
			envelopeId,
			eventType: "source_pdf.upload_rejected",
			message: uploadActor.uploadedBy,
		});
		return c.json(
			{
				error: {
					code: "INVALID_SOURCE_PDF",
					message: "Source document must be a PDF",
					validValues: ["application/pdf"],
				},
			},
			400,
		);
	}
	if (bytes.byteLength > maxSourcePdfBytes) {
		await recordSourcePdfUploadRejection({
			envelopeId,
			eventType: "source_pdf.upload_too_large",
			message: uploadActor.uploadedBy,
		});
		return c.json(
			{
				error: {
					code: "SOURCE_PDF_TOO_LARGE",
					message: "Source PDF must be at most 2 MiB",
					limitBytes: maxSourcePdfBytes,
				},
			},
			413,
		);
	}

	const sha256 = await sha256Hex(bytes);
	const bucket = (c.env as Env & { DOCUMENTS_BUCKET: R2Bucket }).DOCUMENTS_BUCKET;
	try {
		const result = await uploadSourcePdfDocument({
			envelopeId,
			uploadedBy: uploadActor.uploadedBy,
			idempotencyKey: c.req.header("idempotency-key") ?? undefined,
			bytes,
			sha256,
			contentType: "application/pdf",
			originalFilename: parseSourceFilename(c.req.header("x-source-filename")),
			documentsBucket: bucket,
		});
		const selfSign = await prepareSelfSignUploadResponse({
			envelopeId,
			senderSession: uploadActor.senderSession,
			bytes,
			now,
		});
		const historySafeSelfSign = makeHistorySafeSelfSign(
			selfSign,
			envelopeId,
			uploadActor.historyAccess,
		);

		return c.json(
			{
				data: {
					...toSourceDocumentResponse(result.document),
					...(historySafeSelfSign ? { selfSign: historySafeSelfSign } : {}),
				},
			},
			result.reused ? 200 : 201,
		);
	} catch (error) {
		if (error instanceof PdfPolicyError)
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		if (error instanceof SourcePdfUploadError) {
			if (error.code === "DUPLICATE_SOURCE_PDF") {
				await recordSourcePdfUploadRejection({
					envelopeId,
					eventType: "source_pdf.upload_duplicate",
					message: uploadActor.uploadedBy,
				});
				return c.json(
					{
						error: {
							code: "DUPLICATE_SOURCE_PDF",
							message: "Envelope already has a source PDF",
						},
					},
					409,
				);
			}
			return c.json(
				{
					error: {
						code: "ENVELOPE_NOT_DRAFT",
						message: "Source PDFs can only be uploaded while the envelope is draft",
					},
				},
				409,
			);
		}
		throw error;
	}
});

envelopesEndpoint.get("/:id/recipients", async (c) => {
	const createdBy = await getEnvelopeActor(c, c.req.param("id"));
	if (!createdBy) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const recipients = await listRecipients(c.req.param("id"));
	return c.json({ data: recipients.map(toRecipientResponse) });
});

envelopesEndpoint.post("/:id/recipients", async (c) => {
	const createdBy = await getEnvelopeActor(c, c.req.param("id"));
	if (!createdBy) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const parsed = AddRecipientsRequestSchema.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{
				error: {
					code: "INVALID_RECIPIENTS",
					message: "Recipients must include 1 to 10 valid name and email entries",
					limit: 10,
				},
			},
			400,
		);
	}

	const recipients = await addRecipients(c.req.param("id"), parsed.data);
	return c.json({ data: recipients.map(toRecipientResponse) }, 201);
});

envelopesEndpoint.patch("/:id/recipients/:recipientId", async (c) => {
	const createdBy = await getEnvelopeActor(c, c.req.param("id"));
	if (!createdBy) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const parsed = RecipientCreateSchema.safeParse(await c.req.json());
	if (!parsed.success) return c.json(recipientMutationInvalidBody(), 400);

	try {
		const recipient = await updateRecipient(
			c.req.param("id"),
			c.req.param("recipientId"),
			parsed.data,
		);
		return c.json({ data: toRecipientResponse(recipient) });
	} catch (error) {
		return recipientMutationErrorResponse(error, c);
	}
});

envelopesEndpoint.delete("/:id/recipients/:recipientId", async (c) => {
	const createdBy = await getEnvelopeActor(c, c.req.param("id"));
	if (!createdBy) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	try {
		const recipient = await deleteRecipient(c.req.param("id"), c.req.param("recipientId"));
		return c.json({ data: toRecipientResponse(recipient) });
	} catch (error) {
		return recipientMutationErrorResponse(error, c);
	}
});

envelopesEndpoint.post("/:id/recipients/:recipientId/resend", async (c) => {
	const senderId = c.req.header("x-internal-user-id");
	if (!senderId) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	try {
		const result = await resendInvitation(c.req.param("id"), c.req.param("recipientId"), {
			emailDelivery: getEmailDeliveryOptions(c),
		});
		return c.json({ data: result }, 201);
	} catch (error) {
		if (error instanceof EmailDeliveryError) {
			return c.json(emailDeliveryErrorBody(error, c.env as EmailDeliveryEnv | undefined), 502);
		}
		throw error;
	}
});

envelopesEndpoint.get("/:id/fields", async (c) => {
	const userId = await getEnvelopeActor(c, c.req.param("id"));
	if (!userId) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const fields = await listEnvelopeFields(c.req.param("id"));
	return c.json({ data: fields.map(toEnvelopeFieldResponse) });
});

envelopesEndpoint.post("/:id/fields", async (c) => {
	const userId = await getEnvelopeActor(c, c.req.param("id"));
	if (!userId) {
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Missing x-internal-user-id header",
				},
			},
			401,
		);
	}

	const parsed = AddFieldsRequestSchema.safeParse(await c.req.json());
	if (!parsed.success) {
		return c.json(
			{
				error: {
					code: "INVALID_FIELDS",
					message: "Fields must use valid type, page, geometry, and recipient values",
					validFieldTypes: ["signature", "date"],
					allowedActions: ["add_fields"],
				},
			},
			400,
		);
	}

	let fields: Awaited<ReturnType<typeof addFields>>;
	try {
		fields = await addFields(c.req.param("id"), parsed.data);
	} catch (error) {
		if (error instanceof PdfPolicyError)
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		const message = error instanceof Error ? error.message : "Unable to create fields";
		if (message === "Envelope must be draft") {
			return c.json(
				{
					error: {
						code: "ENVELOPE_NOT_DRAFT",
						message: "Fields can only be changed while the envelope is draft",
						allowedActions: getEnvelopeAllowedActions("draft"),
					},
				},
				409,
			);
		}
		if (message === "Field recipient not found") {
			return c.json(
				{
					error: {
						code: "INVALID_FIELDS",
						message: "Fields must use valid type, page, geometry, and recipient values",
						validFieldTypes: ["signature", "date"],
						allowedActions: ["add_fields"],
					},
				},
				400,
			);
		}
		if (error instanceof SignaturePlaceholderLimitError) {
			return c.json(
				{
					error: {
						code: "SIGNATURE_PLACEHOLDER_LIMIT_REACHED",
						message: "Each signer can have one signature placeholder",
						allowedActions: ["add_fields"],
					},
				},
				409,
			);
		}
		throw error;
	}
	return c.json({ data: fields.map(toEnvelopeFieldResponse) }, 201);
});

export default envelopesEndpoint;

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

async function getEnvelopeActor(
	c: Context<{ Bindings: Env }>,
	envelopeId: string,
): Promise<string | null> {
	const historyAccess = await resolveHistoryCreatorRequestAccess(c, envelopeId);
	if (historyAccess) return historyAccess.sender.email;
	const internalUserId = c.req.header("x-internal-user-id");
	if (internalUserId) return internalUserId;
	return getVerifiedSenderUploadEmail(
		c.req.header("x-sender-session-token") ?? c.req.query("senderSessionToken"),
		envelopeId,
		c.req.header("x-now"),
	);
}

async function getEnvelopeControlActor(
	c: Context<{ Bindings: Env }>,
	envelopeId: string,
): Promise<string | Response | null> {
	const internalUserId = c.req.header("x-internal-user-id");
	if (internalUserId) return internalUserId;

	const tokenValue = c.req.header("x-sender-session-token") ?? c.req.query("senderSessionToken");
	if (!tokenValue) return null;

	const now = parseNow(c.req.header("x-now"));
	const scopedSession = await resolveVerifiedSenderSession(tokenValue, envelopeId, now);
	if (scopedSession) return scopedSession.email;

	const identity = await resolveVerifiedSenderIdentity(tokenValue);
	if (!identity) return null;

	const creatorEmail = await getEnvelopeCreatorEmail(envelopeId);
	if (creatorEmail && normalizeEmail(creatorEmail) === normalizeEmail(identity.email)) {
		return normalizeEmail(identity.email);
	}

	return c.json(
		{
			error: {
				code: "CREATOR_CONTROL_FORBIDDEN",
				message: "Only the envelope creator can cancel or delete this envelope",
			},
		},
		403,
	);
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
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

function sendPreconditionErrorBody(error: unknown) {
	const message = error instanceof Error ? error.message : "";
	if (message === "Envelope source PDF required") {
		return {
			error: {
				code: "SOURCE_PDF_REQUIRED",
				message: "Upload a source PDF before sending this envelope",
				allowedActions: ["upload_source_pdf"],
			},
		};
	}
	if (message === "Envelope recipients required") {
		return {
			error: {
				code: "RECIPIENTS_REQUIRED",
				message: "Add recipients before sending this envelope",
				allowedActions: ["add_recipients"],
			},
		};
	}
	if (message === "Envelope recipient fields required") {
		return {
			error: {
				code: "RECIPIENT_FIELDS_REQUIRED",
				message: "Place at least one field for every recipient before sending this envelope",
				allowedActions: ["add_fields"],
			},
		};
	}
	return null;
}

async function getSourcePdfUploadActor(
	c: Context<{ Bindings: Env }>,
	envelopeId: string,
	now: Date,
): Promise<{
	uploadedBy: string;
	senderSession: VerifiedSenderSession | null;
	historyAccess: boolean;
} | null> {
	const historyAccess = await resolveHistoryCreatorRequestAccess(c, envelopeId);
	if (historyAccess) {
		return {
			uploadedBy: historyAccess.sender.email,
			senderSession: {
				envelopeId,
				signingMode: historyAccess.signingMode,
				name: historyAccess.sender.name,
				email: historyAccess.sender.email,
				token: "",
			},
			historyAccess: true,
		};
	}
	const senderSessionToken = c.req.header("x-sender-session-token");
	const senderSession = senderSessionToken
		? await resolveVerifiedSenderSession(senderSessionToken, envelopeId, now)
		: null;
	const uploadedBy =
		c.req.header("x-internal-user-id") ??
		senderSession?.email ??
		(await getVerifiedSenderUploadEmail(senderSessionToken, envelopeId, c.req.header("x-now")));
	return uploadedBy ? { uploadedBy, senderSession, historyAccess: false } : null;
}

function isHistoryCreatorRequest(c: Context<{ Bindings: Env }>): boolean {
	return (
		c.req.header("x-history-session-access") === "true" || c.req.query("historyAccess") === "true"
	);
}

async function resolveHistoryCreatorRequestAccess(
	c: Context<{ Bindings: Env }>,
	envelopeId: string,
): Promise<HistoryCreatorAccess | null> {
	if (!isHistoryCreatorRequest(c)) return null;
	const session = await resolveHistorySessionState(
		getCookie(c, "signmos_history_session") ?? "",
		parseNow(c.req.header("x-now")),
	);
	if (session.state !== "active") return null;
	const authorization = await authorizeHistoryCreator(
		session.session.email,
		envelopeId,
		parseNow(c.req.header("x-now")),
	);
	return authorization.state === "active" ? authorization.access : null;
}

async function prepareSelfSignUploadResponse(input: {
	envelopeId: string;
	senderSession: VerifiedSenderSession | null;
	bytes: Uint8Array;
	now: Date;
}) {
	if (!input.senderSession) return null;
	return prepareSelfSignAfterSourceUpload({
		envelopeId: input.envelopeId,
		sender: {
			name: input.senderSession.name,
			email: input.senderSession.email,
		},
		fieldPage: detectPdfLastPage(input.bytes),
		now: input.now,
	});
}

function makeHistorySafeSelfSign(
	selfSign: Awaited<ReturnType<typeof prepareSelfSignAfterSourceUpload>> | null,
	envelopeId: string,
	historyAccess: boolean,
) {
	if (!selfSign || !historyAccess) return selfSign;
	return { ...selfSign, signingUrl: `/my-documents/${envelopeId}/sign` };
}

function sourcePdfMissingBody() {
	return {
		error: {
			code: "SOURCE_PDF_NOT_FOUND",
			message: "Upload a source PDF before preparing or sending this envelope",
			allowedActions: ["upload_source_pdf"],
		},
	};
}

async function sourcePdfSelfSignResponse(envelopeId: string) {
	const selfSign = await getSelfSignPreparation(envelopeId);
	return selfSign ? { selfSign } : {};
}

function recipientMutationInvalidBody() {
	return {
		error: {
			code: "INVALID_RECIPIENT",
			message: "Recipient must include a valid name and email",
		},
	};
}

function recipientMutationErrorResponse(error: unknown, c: Context<{ Bindings: Env }>) {
	const message = error instanceof Error ? error.message : "";
	if (message === "Envelope must be draft") {
		return c.json(
			{
				error: {
					code: "ENVELOPE_NOT_DRAFT",
					message: "Recipients can only be changed while the envelope is draft",
					allowedActions: getEnvelopeAllowedActions("draft"),
				},
			},
			409,
		);
	}
	if (message === "Recipient not found") {
		return c.json(
			{
				error: {
					code: "RECIPIENT_NOT_FOUND",
					message: "Recipient was not found on this envelope",
				},
			},
			404,
		);
	}
	throw error;
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
