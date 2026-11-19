import { useEffect, useState } from "react";
import { BrandHeader } from "@/components/layout/brand-header";
import { PageShell } from "@/components/layout/page-shell";
import { LoadingText } from "@/components/patterns/loading-text";
import { AgenticAccessConfirmationPage } from "./agentic-access-confirmation-page";

export function AgenticAccessBootstrap() {
	const [credential, setCredential] = useState("");

	useEffect(() => {
		const rawFragment = window.location.hash.slice(1);
		if (rawFragment) {
			setCredential(decodeFragment(rawFragment));
			window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
		}
	}, []);

	if (!credential) {
		return (
			<PageShell width="narrow">
				<BrandHeader />
				<LoadingText boxed>Checking this secure link…</LoadingText>
			</PageShell>
		);
	}
	return <AgenticAccessConfirmationPage credential={credential} />;
}

function decodeFragment(fragment: string): string {
	try {
		return decodeURIComponent(fragment);
	} catch {
		return "";
	}
}
