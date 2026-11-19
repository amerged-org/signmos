import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { resolveSignerToken } from "@/db/envelope/signing";
import { hashSignerSession, signerEmailCookie } from "@/db/signer-email";

/** Personal links are locators; only a token-scoped email proof unlocks their data. */
export async function requireSignerBrowserToken(
	c: Context<{ Bindings: Env }>,
	options: { completion?: boolean } = {},
) {
	const now = new Date(c.req.header("x-now") ?? Date.now());
	const rawSession = getCookie(c, signerEmailCookie);
	const token = await resolveSignerToken(c.req.param("token") ?? "", {
		...options,
		now,
		emailSessionHash: rawSession ? await hashSignerSession(rawSession) : undefined,
	});
	if (!token)
		return Response.json(
			{ error: { code: "TOKEN_NOT_FOUND", message: "Signing token was not found" } },
			{ status: 404 },
		);
	if (token.deletionPending || token.envelopeStatus === "deleted")
		return Response.json(
			{ error: { code: "ENVELOPE_DELETED", message: "This document was deleted by the sender" } },
			{ status: 410 },
		);
	if (token.envelopeStatus === "expired")
		return Response.json(
			{ error: { code: "ENVELOPE_EXPIRED", message: "This signing link is no longer active" } },
			{ status: 410 },
		);
	if (token.expiresAt <= now)
		return Response.json(
			{ error: { code: "EXPIRED_TOKEN", message: "Signing token has expired" } },
			{ status: 410 },
		);
	if (!token.emailSessionVerified)
		return Response.json(
			{
				error: {
					code: "PARTNER_VERIFICATION_REQUIRED",
					message: "Enter the email code to open this document",
					emailHint: token.emailHint,
					verificationUrl: `/signing-verifications/${token.token}`,
				},
			},
			{ status: 403 },
		);
	return token;
}
export function signerSameOriginError(c: Context<{ Bindings: Env }>): Response | undefined {
	const origin = c.req.header("origin");
	if (
		c.req.header("sec-fetch-site") === "cross-site" ||
		(origin && origin !== new URL(c.req.url).origin)
	)
		return Response.json(
			{
				error: {
					code: "ORIGIN_NOT_ALLOWED",
					message: "Open this page on amerged Sign to continue",
				},
			},
			{ status: 403 },
		);
}
