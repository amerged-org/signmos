import { withDatabase } from "@/db/setup";
import { apiHono } from "@/hono/api";
import { publicAgentContractHono } from "@/hono/public-agent-contract";
import { withAdminRequestScope } from "./auth";
import { authorizeHostedRequest } from "./auth-gate";
import { createOmhDocumentsBucket } from "./storage";

/** Use the same authorization gate with both platform and local Worker entries. */
export function dispatchHostedRequest<Result>(
	incoming: Request,
	bindings: Env,
	next: (request: Request) => Promise<Result>,
): Promise<Result | Response> {
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
			const pathname = new URL(request.url).pathname;
			if (pathname.startsWith("/api/")) return apiHono.fetch(request, env);
			if (pathname === "/agent.md" || pathname === "/openapi.json")
				return publicAgentContractHono.fetch(request, env);
			return next(request);
		}),
	);
}
