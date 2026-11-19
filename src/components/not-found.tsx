import { Link } from "@tanstack/react-router";
import { ArrowLeft, Home } from "lucide-react";
import type React from "react";
import { PageHeader, PageShell } from "@/components/layout/page-shell";
import { Panel } from "@/components/patterns/panel";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";

export function NotFound({ children }: { children?: React.ReactNode }) {
	const { language } = useLanguage();
	const copy = {
		de: { title: "Seite nicht gefunden", back: "Zurück", home: "Startseite" },
		en: { title: "Page not found", back: "Back", home: "Home" },
		nl: { title: "Pagina niet gevonden", back: "Terug", home: "Startpagina" },
	}[language];
	return (
		<PageShell width="narrow" center>
			<Panel className="space-y-6">
				<PageHeader title={copy.title} />
				{children ? <div className="text-pretty text-muted-foreground">{children}</div> : null}
				<div className="flex flex-col gap-3 sm:flex-row">
					<Button onClick={() => window.history.back()}>
						<ArrowLeft aria-hidden="true" className="size-4" />
						{copy.back}
					</Button>
					<Button variant="outline" asChild>
						<Link to="/">
							<Home aria-hidden="true" className="size-4" />
							{copy.home}
						</Link>
					</Button>
				</div>
			</Panel>
		</PageShell>
	);
}
