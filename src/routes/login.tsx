import { createFileRoute } from "@tanstack/react-router";
import { ConsoleLogin } from "@/components/console/console-login";

export const Route = createFileRoute("/login")({
	head: () => ({
		meta: [
			{ title: "Anmelden · amerged Sign" },
			{ name: "robots", content: "noindex, nofollow" },
			{ name: "referrer", content: "no-referrer" },
		],
	}),
	component: ConsoleLogin,
});
