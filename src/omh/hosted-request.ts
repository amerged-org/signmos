import { withDatabase } from "@/db";
import { apiHono } from "@/hono/api";
import { publicAgentContractHono } from "@/hono/public-agent-contract";
import { withAdminRequestScope } from "./auth";
import { authorizeHostedRequest } from "./auth-gate";
import { createOmhDocumentsBucket } from "./storage";

/**
 * The hosted request pipeline: request-scoped private database, document storage, the
 * administrator gate, then the Hono API or the rest of the app.
 *
 * The ohmyho.st build writes its own Worker configuration for TanStack Start and bundles the
 * framework's default server entry, so no custom Worker entry (and no wrangler `main`) can carry
 * this. It runs as the first global request middleware instead (see `hosted-middleware.ts`),
 * which sees every request, including paths no TanStack route matches.
 *
 * `next` continues into TanStack Start for pages; API and agent-contract paths are answered here.
 *
 * The API and the agent contract receive the gate's request: x-now, x-internal-user-id,
 * x-signmos-debug and x-sender-session-token are removed from what the client sent, and
 * x-internal-user-id is then set from the administrator the gate verified. A request middleware
 * can only pass `context` to `next`, not a replacement request, so the page leg continues with the
 * client's own request. No page, loader or server function may read those four headers.
 */
export function serveHostedRequest<Result>(
	incoming: Request,
	bindings: Env,
	next: () => Result | PromiseLike<Result>,
): Promise<Response | Result> {
	return withAdminRequestScope(() =>
		withDatabase(bindings, async () => {
			let documents: R2Bucket | undefined;
			const env: Env = {
				...bindings,
				get DOCUMENTS_BUCKET() {
					documents ??= createOmhDocumentsBucket(bindings);
					return documents;
				},
			};
			const authorization = await authorizeHostedRequest(incoming, env);
			if ("response" in authorization) return authorization.response;
			const request = authorization.request;
			const { pathname } = new URL(request.url);

			if (pathname.startsWith("/api/")) return apiHono.fetch(request, env);
			if (pathname === "/agent.md" || pathname === "/openapi.json")
				return publicAgentContractHono.fetch(request, env);
			return next();
		}),
	);
}
