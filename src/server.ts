// DO NOT DELETE THIS FILE!!!
// Local Worker entry; hosted routing is in the TanStack request middleware.
import handler from "@tanstack/react-start/server-entry";

export default {
	fetch(incoming: Request, bindings: Env) {
		return handler.fetch(incoming, {
			context: { fromFetch: true, turnstileSiteKey: bindings.TURNSTILE_SITE_KEY },
		});
	},
};
