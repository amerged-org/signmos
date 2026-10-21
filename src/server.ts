// DO NOT DELETE THIS FILE!!!
// Custom CF Workers entry: routes JSON/public Agent contracts to Hono, rest to TanStack Start
import handler from "@tanstack/react-start/server-entry";
import { withDatabase } from "@/db";
import { apiHono } from "@/hono/api";
import { publicAgentContractHono } from "@/hono/public-agent-contract";
import { authorizeHostedRequest } from "@/omh/auth-gate";
import { createOmhDocumentsBucket } from "@/omh/storage";

export default {
	fetch(incoming: Request, bindings: Env, ctx: ExecutionContext) {
		return withDatabase(bindings, async () => {
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
			const url = new URL(request.url);

			if (url.pathname.startsWith("/api/")) {
				return apiHono.fetch(request, env, ctx);
			}
			if (url.pathname === "/agent.md" || url.pathname === "/openapi.json") {
				return publicAgentContractHono.fetch(request, env, ctx);
			}

			return handler.fetch(request, {
				context: { fromFetch: true, turnstileSiteKey: env.TURNSTILE_SITE_KEY },
			});
		});
	},
};
