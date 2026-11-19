import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

declare module "@tanstack/react-start" {
	interface Register {
		server: {
			requestContext: {
				fromFetch: boolean;
				turnstileSiteKey?: string;
			};
		};
	}
}

const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

const hostedMiddleware = createMiddleware().server(async ({ request, next }) => {
	const [{ env }, { dispatchHostedRequest }] = await Promise.all([
		import("cloudflare:workers"),
		import("@/omh/hosted-request"),
	]);
	const bindings = env as unknown as Env;
	return dispatchHostedRequest(request, bindings, async () => {
		// Start middleware cannot replace the request passed to page routes.
		// Refuse spoofed internal headers before handing those requests on.
		for (const header of [
			"x-internal-user-id",
			"x-now",
			"x-signmos-debug",
			"x-sender-session-token",
		]) {
			if (request.headers.has(header)) return new Response(null, { status: 403 });
		}
		return next({ context: { fromFetch: true, turnstileSiteKey: bindings.TURNSTILE_SITE_KEY } });
	});
});

export const startInstance = createStart(() => {
	return {
		defaultSsr: true,
		requestMiddleware: [hostedMiddleware, csrfMiddleware],
	};
});

startInstance.createMiddleware().server(({ next }) => {
	return next({
		context: {
			fromStartInstanceMw: true,
		},
	});
});
