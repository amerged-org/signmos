import { Download, FileText, MessageSquare, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { pdfPage } from "@/components/envelopes/field-placement-workspace";
import { PageHeader, PageShell } from "@/components/layout/page-shell";
import { LoadingText } from "@/components/patterns/loading-text";
import { Panel } from "@/components/patterns/panel";
import { StatusBadge } from "@/components/patterns/status-badge";
import { TextLink } from "@/components/patterns/text-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type CompleteSigningPayload, PartnerSignatureForm } from "./partner-signature-form";
import {
	type SignerField,
	type SignerPreviewField,
	type SignerSession,
	SigningDocumentPreview,
} from "./signing-document-preview";

interface CompletedDocumentLink {
	url: string;
	downloadUrl: string;
}

interface SigningError {
	message: string;
	verificationUrl?: string;
}

type SignerPageProps = { token: string } | { historyEnvelopeId: string };

export function SignerPage(props: SignerPageProps) {
	const historyMode = "historyEnvelopeId" in props;
	const endpoint = historyMode
		? `/api/history/documents/${encodeURIComponent(props.historyEnvelopeId)}/signing`
		: `/api/signing/${encodeURIComponent(props.token)}`;
	const [session, setSession] = useState<SignerSession | null>(null);
	const [completedDocument, setCompletedDocument] = useState<CompletedDocumentLink | null>(null);
	const [changeComment, setChangeComment] = useState("");
	const [reason, setReason] = useState("");
	const [comment, setComment] = useState("");
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<SigningError | null>(null);
	const [changeRequested, setChangeRequested] = useState(false);
	const dragRef = useRef<{ fieldId: string; offsetX: number; offsetY: number } | null>(null);

	const refreshSigningState = useCallback(
		async (isActive: () => boolean = () => true) => {
			const response = await fetch(endpoint);
			const body = (await response.json()) as {
				data?: SignerSession | { completedDocument: CompletedDocumentLink };
				error?: SigningError;
			};
			if (!isActive()) return;
			setError(body.error ?? null);
			if (body.data && "completedDocument" in body.data) {
				setCompletedDocument(body.data.completedDocument);
				setSession(null);
				return;
			}
			setCompletedDocument(null);
			setSession(body.data ?? null);
		},
		[endpoint],
	);

	useEffect(() => {
		let active = true;
		void refreshSigningState(() => active);
		return () => {
			active = false;
		};
	}, [refreshSigningState]);

	async function completeSigning(payload: CompleteSigningPayload) {
		const response = await fetch(`${endpoint}/complete`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (response.ok) {
			setMessage("Vielen Dank. Deine Unterschrift wurde gespeichert.");
			await refreshSigningState();
			return;
		}
		const body = (await response.json().catch((): { error?: SigningError } => ({}))) as {
			error?: SigningError;
		};
		setMessage(body.error?.message ?? "Die Unterschrift konnte nicht gespeichert werden.");
	}

	async function declineSigning(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const response = await fetch(`${endpoint}/decline`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason, comment: comment || undefined }),
		});
		setMessage(
			response.ok
				? "Die Unterschrift wurde abgelehnt."
				: "Die Ablehnung konnte nicht gespeichert werden.",
		);
		if (response.ok && historyMode) await refreshSigningState();
	}

	async function requestChanges(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const response = await fetch(`${endpoint}/change-request`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ comment: changeComment }),
		});
		if (response.ok) setChangeRequested(true);
		setMessage(
			response.ok
				? "Änderungen wurden angefragt."
				: "Die Änderungsanfrage konnte nicht gesendet werden.",
		);
		if (response.ok && historyMode) await refreshSigningState();
	}

	function startFieldDrag(
		event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>,
		field: SignerPreviewField,
	) {
		const page = event.currentTarget.closest("[data-signing-pdf-page]");
		if (!(page instanceof HTMLElement)) return;
		const point = pointFromPreview(event, page);
		dragRef.current = {
			fieldId: field.id,
			offsetX: point.x - field.x,
			offsetY: point.y - field.y,
		};
		if ("pointerId" in event) event.currentTarget.setPointerCapture?.(event.pointerId);
		event.preventDefault();
	}

	function continueFieldDrag(
		event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>,
	) {
		const drag = dragRef.current;
		if (!drag) return;
		const field = session?.fields.find((candidate) => candidate.id === drag.fieldId);
		if (!session || !field) return;
		const point = pointFromPreview(event, event.currentTarget);
		const nextField = {
			...field,
			x: clamp(Math.round(point.x - drag.offsetX), 0, pdfPage.width - field.width),
			y: clamp(Math.round(point.y - drag.offsetY), 0, pdfPage.height - field.height),
		};
		setSession(moveSessionField(session, nextField));
	}

	async function stopFieldDrag() {
		const drag = dragRef.current;
		if (!drag) return;
		dragRef.current = null;
		const field = session?.fields.find((candidate) => candidate.id === drag.fieldId);
		if (!field || session?.signingMode !== "only_me") return;
		const response = await fetch(`${endpoint}/fields/${field.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ page: field.page, x: field.x, y: field.y }),
		});
		if (!response.ok) {
			setMessage("Das Unterschriftsfeld konnte nicht verschoben werden.");
			await refreshSigningState();
		}
	}

	return (
		<PageShell width="wide">
			<PageHeader
				title="Vertrag prüfen und unterschreiben"
				lead={
					historyMode
						? "Du unterschreibst über deinen bestätigten Zugang."
						: "Prüfe den Vertrag und bestätige ihn mit deiner Unterschrift."
				}
			/>
			{error && (
				<Alert variant="destructive" role="alert">
					<AlertTitle>{error.message}</AlertTitle>
					{error.verificationUrl && (
						<AlertDescription>
							<TextLink href={error.verificationUrl}>E-Mail-Adresse bestätigen</TextLink>
						</AlertDescription>
					)}
				</Alert>
			)}
			{completedDocument && (
				<Panel>
					<div className="flex flex-wrap items-start justify-between gap-4">
						<div className="space-y-2">
							<StatusBadge tone="success">Vertrag abgeschlossen</StatusBadge>
							<p className="text-pretty text-muted-foreground text-sm">
								Der unterzeichnete Vertrag steht für dich zum Download bereit.
							</p>
						</div>
						<div className="flex flex-wrap gap-3">
							<Button asChild variant="outline" size="lg">
								<a href={completedDocument.url}>
									<FileText aria-hidden="true" className="size-4" />
									Unterzeichneten Vertrag ansehen
								</a>
							</Button>
							<Button asChild size="lg">
								<a href={completedDocument.downloadUrl}>
									<Download aria-hidden="true" className="size-4" />
									Unterzeichnete PDF herunterladen
								</a>
							</Button>
						</div>
					</div>
				</Panel>
			)}
			{!session && !error && !completedDocument && (
				<LoadingText boxed>
					<span className="block font-medium text-foreground">Vertrag wird geladen…</span>
					<span className="mt-1 block text-pretty">
						Dein Vertrag und die Unterschriftsfelder werden vorbereitet.
					</span>
				</LoadingText>
			)}
			{session?.sourceDocument && (
				<SigningDocumentPreview
					session={session}
					canDragFields={session.signingMode === "only_me"}
					onStartFieldDrag={startFieldDrag}
					onContinueFieldDrag={continueFieldDrag}
					onStopFieldDrag={stopFieldDrag}
				/>
			)}
			{session && (
				<>
					<Panel className="grid gap-3 md:grid-cols-2">
						{session.fields.length === 0 ? (
							<div className="space-y-1 md:col-span-2">
								<p className="font-medium">Keine Unterschriftsfelder vorhanden</p>
								<p className="text-pretty text-muted-foreground text-sm">
									{session.signingMode === "only_me"
										? "Für diesen Vertrag sind keine Unterschrifts- oder Datumsfelder vorhanden."
										: "Bitte fordere eine Änderung an, wenn eine Unterschrift oder ein Datumsfeld fehlt."}
								</p>
							</div>
						) : (
							session.fields.map((field) => (
								<div key={field.id} className="rounded-lg border bg-muted/30 p-3">
									<p className="font-medium">
										{field.type === "signature" ? "Unterschrift" : "Datum"}
									</p>
									<p className="text-muted-foreground text-sm tabular-nums">Seite {field.page}</p>
								</div>
							))
						)}
					</Panel>
					<PartnerSignatureForm
						key={session.signaturePreference?.id ?? "new-partner-signature"}
						initialPreference={session.signaturePreference}
						disabled={changeRequested || session.fields.length === 0}
						onSubmit={completeSigning}
					/>
					{session.signingMode !== "only_me" && (
						<>
							<form onSubmit={requestChanges} className="grid gap-4 md:grid-cols-3">
								<div className="space-y-2 md:col-span-2">
									<Label htmlFor="changeComment">Gewünschte Änderung</Label>
									<Input
										id="changeComment"
										value={changeComment}
										onChange={(event) => setChangeComment(event.target.value)}
										required
									/>
								</div>
								<div className="flex items-end">
									<Button
										type="submit"
										variant="outline"
										className="w-full"
										disabled={changeRequested}
									>
										<MessageSquare className="h-4 w-4" />
										Änderung anfragen
									</Button>
								</div>
							</form>
							<form onSubmit={declineSigning} className="grid gap-4 md:grid-cols-3">
								<div className="space-y-2">
									<Label htmlFor="declineReason">Grund für die Ablehnung</Label>
									<Input
										id="declineReason"
										value={reason}
										onChange={(event) => setReason(event.target.value)}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="declineComment">Kommentar</Label>
									<Input
										id="declineComment"
										value={comment}
										onChange={(event) => setComment(event.target.value)}
									/>
								</div>
								<div className="flex items-end">
									<Button type="submit" variant="outline" className="w-full">
										<X className="h-4 w-4" />
										Ablehnen
									</Button>
								</div>
							</form>
						</>
					)}
				</>
			)}
			{message && <p className="text-muted-foreground text-sm">{message}</p>}
		</PageShell>
	);
}

function moveSessionField(session: SignerSession, nextField: SignerField): SignerSession {
	return {
		...session,
		fields: session.fields.map((field) => (field.id === nextField.id ? nextField : field)),
		previewFields: session.previewFields?.map((field) =>
			field.id === nextField.id ? { ...field, ...nextField } : field,
		),
	};
}

function pointFromPreview(
	event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>,
	preview: HTMLElement,
): { x: number; y: number } {
	const bounds = preview.getBoundingClientRect();
	if (bounds.width <= 0 || bounds.height <= 0) return { x: event.clientX, y: event.clientY };
	return {
		x: (event.clientX - bounds.left) * (pdfPage.width / bounds.width),
		y: (event.clientY - bounds.top) * (pdfPage.height / bounds.height),
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
