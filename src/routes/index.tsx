import { createFileRoute } from "@tanstack/react-router";
import { SignConsole } from "@/components/console/sign-console";

export const Route = createFileRoute("/")({
	head: () => ({
		meta: [{ title: "Verträge · amerged Sign" }, { name: "robots", content: "noindex, nofollow" }],
	}),
	component: SignConsole,
});
