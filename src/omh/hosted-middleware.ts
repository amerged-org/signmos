import { env } from "cloudflare:workers";
import { createMiddleware } from "@tanstack/react-start";
import { serveHostedRequest } from "./hosted-request";

/** Global request middleware: the hosted gate and API run in front of every TanStack request. */
export const hostedRequestMiddleware = createMiddleware({ type: "request" }).server(
	({ request, next }) => serveHostedRequest(request, env as unknown as Env, () => next()),
);
