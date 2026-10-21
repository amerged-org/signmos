import { type AgenticPrincipal, authenticateAgenticBearer } from "@/db/agentic-access";
import { resolveHistorySessionState, type VerifiedHistorySession } from "@/db/history-access";

export const adminSessionCookie = "signmos_history_session";

export interface AdminAuthEnv {
	SIGN_ADMIN_EMAILS?: string;
}

export interface AdminPrincipal {
	email: string;
	session?: VerifiedHistorySession;
	agent?: AgenticPrincipal;
}

export type AdminAuthorization =
	| { ok: true; principal: AdminPrincipal }
	| { ok: false; response: Response };

export function isAllowedAdmin(email: string, env: AdminAuthEnv): boolean {
	const normalized = email.trim().toLowerCase();
	return (
		Boolean(normalized) &&
		(env.SIGN_ADMIN_EMAILS ?? "")
			.split(",")
			.some((candidate) => candidate.trim().toLowerCase() === normalized)
	);
}

export function adminAuthConfigured(env: AdminAuthEnv): boolean {
	return (env.SIGN_ADMIN_EMAILS ?? "")
		.split(",")
		.some((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()));
}

export function readAdminSessionCookie(request: Request): string {
	const value = request.headers
		.get("cookie")
		?.split(";")
		.find((part) => part.trim().startsWith(`${adminSessionCookie}=`));
	return value?.trim().slice(adminSessionCookie.length + 1) ?? "";
}

export function isSameOrigin(request: Request): boolean {
	return request.headers.get("origin") === new URL(request.url).origin;
}

export async function createAdminCsrfToken(rawSession: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`amerged-sign-csrf:${rawSession}`),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function resolveAdminRequest(
	request: Request,
	env: AdminAuthEnv,
	options: { allowBearer?: boolean; requireBearer?: boolean; requireCsrf?: boolean } = {},
): Promise<AdminAuthorization> {
	if (!adminAuthConfigured(env))
		return denied("ADMIN_NOT_CONFIGURED", "Administrator access is not configured", 503);
	const authorization = request.headers.get("authorization");
	if (authorization && options.allowBearer) {
		const agent = await authenticateAgenticBearer({ authorization, requestIp: requestIp(request) });
		if (!agent || !isAllowedAdmin(agent.email, env))
			return denied("ADMIN_ACCESS_DENIED", "Administrator access required", 403);
		return { ok: true, principal: { email: agent.email.trim().toLowerCase(), agent } };
	}
	if (options.requireBearer)
		return denied("API_TOKEN_REQUIRED", "A valid Bearer API token is required", 403);
	const rawSession = readAdminSessionCookie(request);
	if (!rawSession) return denied("ADMIN_SESSION_REQUIRED", "Sign in to continue", 403);
	const state = await resolveHistorySessionState(rawSession, new Date(), requestIp(request));
	if (state.state !== "active" || !isAllowedAdmin(state.session.email, env))
		return denied("ADMIN_ACCESS_DENIED", "Sign in with an authorized email", 403);
	const requiresCsrf = options.requireCsrf ?? !["GET", "HEAD", "OPTIONS"].includes(request.method);
	if (
		requiresCsrf &&
		(!isSameOrigin(request) ||
			request.headers.get("x-csrf-token") !== (await createAdminCsrfToken(rawSession)))
	) {
		return denied("CSRF_REJECTED", "Refresh this page and try again", 403);
	}
	return {
		ok: true,
		principal: { email: state.session.email.trim().toLowerCase(), session: state.session },
	};
}

export function requestIp(request: Request): string {
	return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export function denied(
	code: string,
	message: string,
	status: 400 | 403 | 404 | 409 | 410 | 429 | 503,
): { ok: false; response: Response } {
	return {
		ok: false,
		response: Response.json(
			{ error: { code, message } },
			{ status, headers: { "cache-control": "no-store" } },
		),
	};
}
