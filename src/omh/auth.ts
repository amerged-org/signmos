import { AsyncLocalStorage } from "node:async_hooks";
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

interface VerifiedAdminRequest {
	kind: "bearer" | "session";
	credential: string;
	ip: string;
	principal: AdminPrincipal;
}

interface AdminRequestScope {
	active: boolean;
	verified: WeakMap<Request, VerifiedAdminRequest>;
}

const adminRequestContext = new AsyncLocalStorage<AdminRequestScope>();

/** Reuse verified identity only until this HTTP request finishes. */
export function withAdminRequestScope<Result>(run: () => Promise<Result>): Promise<Result> {
	const scope: AdminRequestScope = { active: true, verified: new WeakMap() };
	return adminRequestContext.run(scope, async () => {
		try {
			return await run();
		} finally {
			scope.active = false;
		}
	});
}

/** Carry the gate's verified identity to its exact sanitized dispatch request. */
export function rememberVerifiedAdminRequest(
	verifiedRequest: Request,
	forwardedRequest: Request,
): void {
	const scope = adminRequestContext.getStore();
	const verified = scope?.active ? scope.verified.get(verifiedRequest) : undefined;
	if (verified) scope?.verified.set(forwardedRequest, verified);
}

function cachedPrincipal(
	request: Request,
	kind: VerifiedAdminRequest["kind"],
	credential: string,
): AdminPrincipal | undefined {
	const scope = adminRequestContext.getStore();
	const verified = scope?.active ? scope.verified.get(request) : undefined;
	return verified?.kind === kind &&
		verified.credential === credential &&
		verified.ip === requestIp(request)
		? verified.principal
		: undefined;
}

function authorized(
	request: Request,
	kind: VerifiedAdminRequest["kind"],
	credential: string,
	principal: AdminPrincipal,
): AdminAuthorization {
	const scope = adminRequestContext.getStore();
	if (scope?.active)
		scope.verified.set(request, { kind, credential, ip: requestIp(request), principal });
	return { ok: true, principal };
}

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
		const agent =
			cachedPrincipal(request, "bearer", authorization)?.agent ??
			(await authenticateAgenticBearer({ authorization, requestIp: requestIp(request) }));
		if (!agent || !isAllowedAdmin(agent.email, env))
			return denied("ADMIN_ACCESS_DENIED", "Administrator access required", 403);
		return authorized(request, "bearer", authorization, {
			email: agent.email.trim().toLowerCase(),
			agent,
		});
	}
	if (options.requireBearer)
		return denied("API_TOKEN_REQUIRED", "A valid Bearer API token is required", 403);
	const rawSession = readAdminSessionCookie(request);
	if (!rawSession) return denied("ADMIN_SESSION_REQUIRED", "Sign in to continue", 403);
	const session = await resolveAdminSession(request, rawSession);
	if (!session || !isAllowedAdmin(session.email, env))
		return denied("ADMIN_ACCESS_DENIED", "Sign in with an authorized email", 403);
	const requiresCsrf = options.requireCsrf ?? !["GET", "HEAD", "OPTIONS"].includes(request.method);
	if (
		requiresCsrf &&
		(!isSameOrigin(request) ||
			request.headers.get("x-csrf-token") !== (await createAdminCsrfToken(rawSession)))
	) {
		return denied("CSRF_REJECTED", "Refresh this page and try again", 403);
	}
	return authorized(request, "session", rawSession, {
		email: session.email.trim().toLowerCase(),
		session,
	});
}

async function resolveAdminSession(
	request: Request,
	rawSession: string,
): Promise<VerifiedHistorySession | null> {
	const now = new Date();
	const cached = cachedPrincipal(request, "session", rawSession)?.session;
	if (cached && cached.expiresAt > now) return cached;
	const state = await resolveHistorySessionState(rawSession, now, requestIp(request));
	return state.state === "active" ? state.session : null;
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
