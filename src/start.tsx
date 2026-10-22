import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { hostedRequestMiddleware } from "@/omh/hosted-middleware";

const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => {
	return {
		defaultSsr: true,
		// The hosted gate runs first: it answers /api and denies unauthenticated pages itself.
		requestMiddleware: [hostedRequestMiddleware, csrfMiddleware],
	};
});

startInstance.createMiddleware().server(({ next }) => {
	return next({
		context: {
			fromStartInstanceMw: true,
		},
	});
});
