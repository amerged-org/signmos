import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { BrandHeader } from "@/components/layout/brand-header";
import { PageShell } from "@/components/layout/page-shell";
import { LoadingText } from "@/components/patterns/loading-text";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";

interface CompletedDocumentView {
	envelopeId: string;
	status: "completed";
	finalPdf: { downloadUrl: string; byteSize: number; sha256: string };
	parties: Array<{
		id: string;
		name: string;
		email: string;
		status: string;
		signedDate: string | null;
	}>;
	history: Array<{ type: string; title: string; detail: string | null; occurredAt: string }>;
}

const copy = {
	de: {
		title: "Vertrag abgeschlossen",
		download: "PDF herunterladen",
		loading: "Vertrag wird geladen…",
		unavailable: "Vertrag nicht verfügbar.",
		signers: "Unterzeichnet von",
		signed: "Unterzeichnet",
		missingDate: "Datum nicht erfasst",
		details: "Details",
		history: "Verlauf",
		hash: "Dokument-Hash",
		document: "Dokument",
		size: "Dateigröße",
		bytes: "Byte",
		events: {
			document_uploaded: "Dokument hochgeladen",
			document_revised: "Dokument überarbeitet",
			sent: "Versendet",
			viewed: "hat das Dokument angesehen",
			signed: "hat unterschrieben",
			changes_requested: "hat Änderungen angefragt",
			declined: "hat abgelehnt",
			canceled: "Abgebrochen",
			expired: "Abgelaufen",
			deleted: "Gelöscht",
		},
	},
	en: {
		title: "Document completed",
		download: "Download PDF",
		loading: "Loading document…",
		unavailable: "Document unavailable.",
		signers: "Signed by",
		signed: "Signed",
		missingDate: "Date not recorded",
		details: "Details",
		history: "History",
		hash: "Document hash",
		document: "Document",
		size: "File size",
		bytes: "bytes",
		events: {
			document_uploaded: "Document uploaded",
			document_revised: "Document revised",
			sent: "Sent",
			viewed: "viewed the document",
			signed: "signed",
			changes_requested: "requested changes",
			declined: "declined",
			canceled: "Canceled",
			expired: "Expired",
			deleted: "Deleted",
		},
	},
	nl: {
		title: "Document afgerond",
		download: "PDF downloaden",
		loading: "Document laden…",
		unavailable: "Document niet beschikbaar.",
		signers: "Ondertekend door",
		signed: "Ondertekend",
		missingDate: "Datum niet vastgelegd",
		details: "Details",
		history: "Geschiedenis",
		hash: "Documenthash",
		document: "Document",
		size: "Bestandsgrootte",
		bytes: "bytes",
		events: {
			document_uploaded: "Document geüpload",
			document_revised: "Document gewijzigd",
			sent: "Verzonden",
			viewed: "heeft het document bekeken",
			signed: "heeft ondertekend",
			changes_requested: "heeft wijzigingen gevraagd",
			declined: "heeft geweigerd",
			canceled: "Geannuleerd",
			expired: "Verlopen",
			deleted: "Verwijderd",
		},
	},
} as const;

export function CompletedDocumentPage({ token }: { token: string }) {
	const { language } = useLanguage();
	const text = copy[language];
	const [view, setView] = useState<CompletedDocumentView | null>(null);
	const [error, setError] = useState(false);

	useEffect(() => {
		let active = true;
		fetch(`/api/final-documents/${encodeURIComponent(token)}`)
			.then(async (response) => {
				const body = (await response.json()) as { data?: CompletedDocumentView };
				if (!active) return;
				if (response.ok && body.data) {
					setView(body.data);
					setError(false);
					return;
				}
				setError(true);
			})
			.catch(() => {
				if (active) setError(true);
			});
		return () => {
			active = false;
		};
	}, [token]);

	return (
		<PageShell width="content">
			<header className="space-y-7 border-b border-foreground pb-8">
				<BrandHeader />
				{view && (
					<>
						<h1 className="font-serif text-4xl font-normal tracking-tight sm:text-5xl">
							{text.title}
							<span className="text-destructive">.</span>
						</h1>
						<Button asChild size="lg">
							<a href={view.finalPdf.downloadUrl}>
								<Download aria-hidden="true" className="size-4" />
								{text.download}
							</a>
						</Button>
					</>
				)}
			</header>
			{!view && !error && <LoadingText boxed>{text.loading}</LoadingText>}
			{error && (
				<Alert variant="destructive" role="alert">
					<AlertTitle>{text.unavailable}</AlertTitle>
				</Alert>
			)}
			{view && (
				<>
					<section className="space-y-4" aria-labelledby="completed-signers">
						<h2 id="completed-signers" className="font-serif text-2xl">
							{text.signers}
						</h2>
						<ul className="divide-y border-y">
							{view.parties.map((party) => (
								<li
									key={party.id}
									className="flex flex-wrap items-start justify-between gap-3 py-4"
								>
									<div>
										<p>{party.name}</p>
										<p className="break-all text-sm text-muted-foreground">{party.email}</p>
									</div>
									{party.status === "completed" && (
										<p className="text-sm text-muted-foreground">
											{text.signed} · {party.signedDate ?? text.missingDate}
										</p>
									)}
								</li>
							))}
						</ul>
					</section>
					<details className="border-y py-4">
						<summary className="cursor-pointer font-mono text-xs uppercase tracking-wide">
							{text.details}
						</summary>
						<div className="space-y-5 pt-5 text-sm">
							<p className="break-all">
								<span className="text-muted-foreground">{text.document}: </span>
								{view.envelopeId}
							</p>
							<p>
								<span className="text-muted-foreground">{text.size}: </span>
								{view.finalPdf.byteSize.toLocaleString(language)} {text.bytes}
							</p>
							<p className="break-all">
								<span className="text-muted-foreground">{text.hash}: </span>
								{view.finalPdf.sha256}
							</p>
							<h2 className="font-serif text-xl">{text.history}</h2>
							<ol className="space-y-3">
								{view.history.map((event) => (
									<li key={`${event.type}-${event.occurredAt}`} className="border-t pt-3">
										<p>{eventTitle(event, text.events)}</p>
										<p className="text-muted-foreground">
											<time dateTime={event.occurredAt}>{event.occurredAt}</time>
											{event.detail && <> · {event.detail}</>}
										</p>
									</li>
								))}
							</ol>
						</div>
					</details>
				</>
			)}
		</PageShell>
	);
}

function eventTitle(
	event: CompletedDocumentView["history"][number],
	labels: Record<string, string>,
): string {
	const label = labels[event.type];
	if (!label) return event.title;
	if (!["viewed", "signed", "changes_requested", "declined"].includes(event.type)) return label;
	const name = event.title.replace(/ (viewed the document|signed|requested changes|declined)$/, "");
	return name === event.title ? label : `${name} ${label}`;
}
