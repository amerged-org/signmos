import { setCookie } from "hono/cookie";
import type { EmailDeliveryEnv } from "@/db/envelope/email-delivery";
import {
	requestSignerEmailCode,
	type SignerEmailEnv,
	SignerEmailError,
	signerEmailCookie,
	verifySignerEmailCode,
} from "@/db/signer-email";
import { VerifySignerEmailCodeSchema } from "@/db/signer-email/schema";
import { createHono } from "@/hono/factory";
import { getRequestIp } from "./envelope-route-helpers";
import { signerSameOriginError } from "./signer-email-auth";

const endpoint = createHono();
endpoint.post("/:token/email-code/request", async (c) => {
	const originError = signerSameOriginError(c);
	if (originError) return originError;
	try {
		return c.json({
			data: await requestSignerEmailCode({
				token: c.req.param("token"),
				now: new Date(c.req.header("x-now") ?? Date.now()),
				requestIp: getRequestIp(c.req.header("cf-connecting-ip"), c.req.header("x-forwarded-for")),
				env: c.env as SignerEmailEnv,
				emailDelivery: { env: c.env as EmailDeliveryEnv, baseUrl: new URL(c.req.url).origin },
			}),
		});
	} catch (error) {
		if (error instanceof SignerEmailError) return errorResponse(error);
		throw error;
	}
});
endpoint.post("/:token/email-code/verify", async (c) => {
	const originError = signerSameOriginError(c);
	if (originError) return originError;
	const input = VerifySignerEmailCodeSchema.safeParse(await c.req.json().catch(() => null));
	if (!input.success)
		return c.json(
			{ error: { code: "INVALID_EMAIL_CODE", message: "Enter the six digit code" } },
			400,
		);
	try {
		const result = await verifySignerEmailCode({
			token: c.req.param("token"),
			code: input.data.code,
			now: new Date(c.req.header("x-now") ?? Date.now()),
			env: c.env as SignerEmailEnv,
		});
		setCookie(c, signerEmailCookie, result.rawSession, {
			httpOnly: true,
			secure:
				(c.env as EmailDeliveryEnv)?.CLOUDFLARE_ENV === "production" ||
				new URL(c.req.url).protocol === "https:",
			sameSite: "Strict",
			path: "/api/",
			expires: result.expiresAt,
		});
		return c.json({ data: { verified: true, signingUrl: result.signingUrl } });
	} catch (error) {
		if (error instanceof SignerEmailError) return errorResponse(error);
		throw error;
	}
});
function errorResponse(error: SignerEmailError) {
	return Response.json(
		{
			error: {
				code: error.code,
				message: error.message,
				...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
			},
		},
		{
			status: error.status,
			headers: error.retryAfterSeconds
				? { "Retry-After": String(error.retryAfterSeconds) }
				: undefined,
		},
	);
}
export default endpoint;
