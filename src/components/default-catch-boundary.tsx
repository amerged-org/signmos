import type { ErrorComponentProps } from "@tanstack/react-router";
import { Link, useRouter } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { PageHeader, PageShell } from "@/components/layout/page-shell";
import { Panel } from "@/components/patterns/panel";
import { Button } from "@/components/ui/button";

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
	const router = useRouter();
	return (
		<PageShell width="narrow" center>
			<Panel className="space-y-6">
				<AlertTriangle aria-hidden="true" className="size-6 text-destructive" />
				<PageHeader
					title="Diese Seite ist gerade nicht verfügbar"
					lead="Bitte versuche es erneut. Dein Vertrag wird dadurch nicht verändert."
				/>
				{import.meta.env.DEV && error instanceof Error && (
					<p className="text-sm text-muted-foreground">{error.message}</p>
				)}
				<div className="flex flex-wrap gap-3">
					<Button onClick={() => router.invalidate()}>
						<RefreshCw aria-hidden="true" className="size-4" />
						Erneut versuchen
					</Button>
					<Button variant="outline" asChild>
						<Link to="/">Zur Übersicht</Link>
					</Button>
				</div>
			</Panel>
		</PageShell>
	);
}
