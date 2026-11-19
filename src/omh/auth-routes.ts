import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { AgenticTokenLimitError, listAgenticTokens } from "@/db/agentic-access";
import { HistoryRequestRateLimitError, revokeHistorySession } from "@/db/history-access";
import { createHono } from "@/hono/factory";
import {
	adminAuthConfigured,
	adminSessionCookie,
	createAdminCsrfToken,
	denied,
	isSameOrigin,
	readAdminSessionCookie,
	requestIp,
	resolveAdminRequest,
} from "./auth";
import { redeemAdminLogin, requestAdminLogin } from "./auth-login";
import { createAdminApiToken, revokeAdminApiToken } from "./auth-tokens";

const LoginRequestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const LoginRedemptionSchema = z.object({ credential: z.string().min(32).max(200) });
const TokenRequestSchema = z.object({ name: z.string().trim().min(1).max(100) });
const authEndpoint = createHono();

authEndpoint.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	return next();
});

authEndpoint.post("/request-login", async (c) => {
	if (!isSameOrigin(c.req.raw))
		return denied("INVALID_ORIGIN", "Open the login page to continue", 403).response;
	if (!adminAuthConfigured(c.env))
		return denied("ADMIN_NOT_CONFIGURED", "Administrator access is not configured", 503).response;
	const parsed = LoginRequestSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return denied("INVALID_EMAIL", "Enter a valid email address", 400).response;
	try {
		await requestAdminLogin({
			email: parsed.data.email,
			env: c.env,
			requestIp: requestIp(c.req.raw),
			emailDelivery: { env: c.env, baseUrl: new URL(c.req.url).origin },
		});
	} catch (error) {
		if (error instanceof HistoryRequestRateLimitError)
			return denied("LOGIN_RATE_LIMITED", "Please wait before requesting another login", 429)
				.response;
		// Email delivery failures must not expose login credentials or provider payloads.
		return denied("LOGIN_UNAVAILABLE", "Login email is temporarily unavailable", 503).response;
	}
	return c.json({ data: { status: "accepted" } }, 202);
});

authEndpoint.post("/redeem-login", async (c) => {
	if (!isSameOrigin(c.req.raw))
		return denied("INVALID_ORIGIN", "Open the login page to continue", 403).response;
	if (!adminAuthConfigured(c.env))
		return denied("ADMIN_NOT_CONFIGURED", "Administrator access is not configured", 503).response;
	const parsed = LoginRedemptionSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success)
		return denied("INVALID_LOGIN_LINK", "Request a new login link", 400).response;
	const result = await redeemAdminLogin({
		credential: parsed.data.credential,
		env: c.env,
		requestIp: requestIp(c.req.raw),
	});
	if (result.status !== "authenticated")
		return denied("LOGIN_LINK_UNAVAILABLE", "Request a new login link", 410).response;
	setCookie(c, adminSessionCookie, result.rawSession, {
		path: "/",
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		expires: result.expiresAt,
		maxAge: 8 * 60 * 60,
	});
	return c.json({ data: { status: "authenticated", redirectUrl: "/" } }, 201);
});

authEndpoint.get("/session", async (c) => {
	const auth = await resolveAdminRequest(c.req.raw, c.env);
	if (!auth.ok) return c.json({ data: { authenticated: false } });
	return c.json({
		data: {
			authenticated: true,
			email: auth.principal.email,
			csrfToken: await createAdminCsrfToken(readAdminSessionCookie(c.req.raw)),
			expiresAt: auth.principal.session?.expiresAt.toISOString(),
		},
	});
});

authEndpoint.post("/logout", async (c) => {
	const auth = await resolveAdminRequest(c.req.raw, c.env);
	if (!auth.ok) return auth.response;
	await revokeHistorySession(readAdminSessionCookie(c.req.raw), new Date(), requestIp(c.req.raw));
	deleteCookie(c, adminSessionCookie, { path: "/", httpOnly: true, secure: true, sameSite: "Lax" });
	return c.body(null, 204);
});

authEndpoint.get("/tokens", async (c) => {
	const auth = await resolveAdminRequest(c.req.raw, c.env);
	if (!auth.ok) return auth.response;
	const tokens = await listAgenticTokens(auth.principal.email);
	return c.json({
		data: tokens.tokens.filter((token) => token.status === "active" || token.status === "revoked"),
	});
});

authEndpoint.post("/tokens", async (c) => {
	const auth = await resolveAdminRequest(c.req.raw, c.env);
	if (!auth.ok) return auth.response;
	if (!auth.principal.session)
		return denied("ADMIN_SESSION_REQUIRED", "Sign in to manage API tokens", 403).response;
	const parsed = TokenRequestSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success)
		return denied("INVALID_TOKEN_NAME", "Enter a name for the API token", 400).response;
	try {
		return c.json(
			{
				data: await createAdminApiToken(
					auth.principal.session,
					parsed.data.name,
					requestIp(c.req.raw),
				),
			},
			201,
		);
	} catch (error) {
		if (error instanceof AgenticTokenLimitError)
			return denied("API_TOKEN_LIMIT", "Revoke an active token before creating another", 409)
				.response;
		throw error;
	}
});

authEndpoint.delete("/tokens/:id", async (c) => {
	const auth = await resolveAdminRequest(c.req.raw, c.env);
	if (!auth.ok) return auth.response;
	if (!auth.principal.session)
		return denied("ADMIN_SESSION_REQUIRED", "Sign in to manage API tokens", 403).response;
	const parsed = z.string().uuid().safeParse(c.req.param("id"));
	if (!parsed.success) return denied("INVALID_TOKEN_ID", "API token not found", 404).response;
	const revoked = await revokeAdminApiToken(
		auth.principal.session,
		parsed.data,
		requestIp(c.req.raw),
	);
	if (revoked.state !== "revoked")
		return denied("API_TOKEN_NOT_FOUND", "Active API token not found", 404).response;
	return c.json({ data: { token: revoked.token } });
});

export default authEndpoint;
