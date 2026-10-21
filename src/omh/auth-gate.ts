import { getEnvelopeCreatorEmail } from "@/db/envelope";
import { type AdminAuthEnv, type AdminPrincipal, denied, resolveAdminRequest } from "./auth";

export type HostedRequestAuthorization =
	| { request: Request; principal?: AdminPrincipal }
	| { response: Response };

const publicApiPaths = [/^\/api\/signing\//, /^\/api\/final-documents\//];
const publicPagePaths = [
	/^\/login\/?$/,
	/^\/signing\//,
	/^\/signing-verifications\//,
	/^\/completed-documents\//,
];
const staticPaths = [
	/^\/assets\//,
	/^\/_build\//,
	/^\/fonts\//,
	/^\/favicon(?:\.ico|-\d+x\d+\.png)$/,
	/^\/(?:apple-touch-icon\.png|logo(?:192|512)\.png|manifest\.json|robots\.txt|signmos-(?:og\.png|thumbnail\.png|build-week-sample\.pdf))$/,
];

export async function authorizeHostedRequest(
	request: Request,
	env: AdminAuthEnv,
): Promise<HostedRequestAuthorization> {
	const clean = cleanRequest(request);
	const path = new URL(clean.url).pathname;
	if (path === "/api/health/live") return { request: clean };
	if (path.startsWith("/api/auth/") || publicApiPaths.some((pattern) => pattern.test(path)))
		return { request: clean };
	if (
		publicPagePaths.some((pattern) => pattern.test(path)) ||
		staticPaths.some((pattern) => pattern.test(path))
	)
		return { request: clean };
	if (
		path.startsWith("/api/agentic/") ||
		path.startsWith("/api/history/access-") ||
		path === "/api/envelopes/sender-start" ||
		path.startsWith("/api/envelopes/sender-verifications/")
	) {
		return {
			response: denied("LEGACY_ACCESS_DISABLED", "Use the amerged Sign login and API", 404)
				.response,
		};
	}
	const auth = await resolveAdminRequest(clean, env, {
		allowBearer:
			path.startsWith("/api/v1/") ||
			path === "/api/contracts" ||
			path.startsWith("/api/contracts/"),
	});
	if (!auth.ok) {
		if (!path.startsWith("/api/"))
			return {
				response: new Response(null, {
					status: 303,
					headers: { location: "/login", "cache-control": "no-store" },
				}),
			};
		return { response: auth.response };
	}
	const ownershipError = await envelopeOwnershipError(path, auth.principal.email);
	if (ownershipError) return { response: ownershipError };
	const headers = new Headers(clean.headers);
	headers.set("x-internal-user-id", auth.principal.email);
	return { request: new Request(clean, { headers }), principal: auth.principal };
}

async function envelopeOwnershipError(path: string, email: string): Promise<Response | null> {
	const segment = /^\/api\/envelopes\/([^/]+)(?:\/|$)/.exec(path)?.[1];
	if (!segment) return null;
	let envelopeId: string;
	try {
		envelopeId = decodeURIComponent(segment);
	} catch {
		return denied("CONTRACT_NOT_FOUND", "Contract not found", 404).response;
	}
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(envelopeId))
		return denied("CONTRACT_NOT_FOUND", "Contract not found", 404).response;
	const owner = await getEnvelopeCreatorEmail(envelopeId);
	return owner?.trim().toLowerCase() === email
		? null
		: denied("CONTRACT_NOT_FOUND", "Contract not found", 404).response;
}

function cleanRequest(request: Request): Request {
	const headers = new Headers(request.headers);
	for (const header of ["x-internal-user-id", "x-now", "x-signmos-debug", "x-sender-session-token"])
		headers.delete(header);
	return new Request(request, { headers });
}
