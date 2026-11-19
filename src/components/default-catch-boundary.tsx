import type { ErrorComponentProps } from "@tanstack/react-router";
import { Link, useRouter } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { PageHeader, PageShell } from "@/components/layout/page-shell";
import { Panel } from "@/components/patterns/panel";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
	const router = useRouter();
	const { language } = useLanguage();
	const copy = {
		de: { title: "Seite nicht verfügbar", retry: "Erneut versuchen", home: "Startseite" },
		en: { title: "Page unavailable", retry: "Try again", home: "Home" },
		nl: { title: "Pagina niet beschikbaar", retry: "Opnieuw proberen", home: "Startpagina" },
	}[language];
	return (
		<PageShell width="narrow" center>
			<Panel className="space-y-6">
				<AlertTriangle aria-hidden="true" className="size-6 text-destructive" />
				<PageHeader title={copy.title} />
				{import.meta.env.DEV && error instanceof Error && (
					<p className="text-sm text-muted-foreground">{error.message}</p>
				)}
				<div className="flex flex-wrap gap-3">
					<Button onClick={() => router.invalidate()}>
						<RefreshCw aria-hidden="true" className="size-4" />
						{copy.retry}
					</Button>
					<Button variant="outline" asChild>
						<Link to="/">{copy.home}</Link>
					</Button>
				</div>
			</Panel>
		</PageShell>
	);
}
