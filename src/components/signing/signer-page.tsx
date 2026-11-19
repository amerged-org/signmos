import { Download, FileText, MessageSquare, X } from "lucide-react";
import { Activity, useCallback, useEffect, useRef, useState } from "react";
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
import { useLanguage } from "@/lib/i18n";
import { type CompleteSigningPayload, PartnerSignatureForm } from "./partner-signature-form";
import { type SigningLanguage, signingCopy, signingError } from "./signing-copy";
import {
	type SignerField,
	type SignerPreviewField,
	type SignerSession,
	SigningDocumentPreview,
	signerFieldLabel,
} from "./signing-document-preview";
import { SigningVerificationPage } from "./signing-verification-page";

interface CompletedDocumentLink {
	url: string;
	downloadUrl: string;
}

interface SigningError {
	code?: string;
	emailHint?: string;
	verificationUrl?: string;
}

type SignerPageProps = { token: string } | { historyEnvelopeId: string };

export function SignerPage(props: SignerPageProps) {
	const { language } = useLanguage();
	const copy = signingCopy[language];
	const historyMode = "historyEnvelopeId" in props;
	const endpoint = signingEndpoint(props);
	const [session, setSession] = useState<SignerSession | null>(null);
	const [completedDocument, setCompletedDocument] = useState<CompletedDocumentLink | null>(null);
	const [changeComment, setChangeComment] = useState("");
	const [reason, setReason] = useState("");
	const [comment, setComment] = useState("");
	const [message, setMessage] = useState<
		| "saved"
		| "saveFailed"
		| "declined"
		| "declineFailed"
		| "changeSent"
		| "changeFailed"
		| "moveFailed"
		| null
	>(null);
	const [completionError, setCompletionError] = useState<string | undefined>();
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

	async function recoverEmailVerification(response: Response) {
		if (response.status !== 403) return false;
		const body = (await response
			.clone()
			.json()
			.catch(() => ({}))) as {
			error?: SigningError;
		};
		if (!personalVerification(props, body.error ?? null)) return false;
		setError(body.error ?? null);
		setMessage(null);
		setCompletionError(undefined);
		return true;
	}

	async function completeSigning(payload: CompleteSigningPayload) {
		const response = await fetch(`${endpoint}/complete`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (await recoverEmailVerification(response)) return;
		if (response.ok) {
			setCompletionError(undefined);
			setMessage("saved");
			await refreshSigningState();
			return;
		}
		const body = (await response.json().catch((): { error?: SigningError } => ({}))) as {
			error?: SigningError;
		};
		setCompletionError(body.error?.code);
		setMessage("saveFailed");
	}

	async function declineSigning(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const response = await fetch(`${endpoint}/decline`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason, comment: comment || undefined }),
		});
		if (await recoverEmailVerification(response)) return;
		setMessage(response.ok ? "declined" : "declineFailed");
		if (response.ok && historyMode) await refreshSigningState();
	}

	async function requestChanges(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const response = await fetch(`${endpoint}/change-request`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ comment: changeComment }),
		});
		if (await recoverEmailVerification(response)) return;
		if (response.ok) setChangeRequested(true);
		setMessage(response.ok ? "changeSent" : "changeFailed");
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
			setMessage("moveFailed");
			await refreshSigningState();
		}
	}

	const verification = personalVerification(props, error);
	const content = (
		<PageShell width="wide">
			<PageHeader title={copy.pageTitle} />
			{session && (
				<a
					href="#signer-fields"
					className="inline-flex min-h-11 items-center border-b border-destructive font-mono text-xs uppercase tracking-wide text-foreground lg:hidden"
				>
					{copy.jump}
				</a>
			)}
			{error && <SigningAccessError error={error} language={language} />}
			{completedDocument && (
				<Panel>
					<div className="flex flex-wrap items-start justify-between gap-4">
						<div className="space-y-2">
							<StatusBadge tone="success">{copy.completed}</StatusBadge>
							<p className="text-pretty text-muted-foreground text-sm">{copy.completedHint}</p>
						</div>
						<div className="flex flex-wrap gap-3">
							<Button asChild variant="outline" size="lg">
								<a href={completedDocument.url}>
									<FileText aria-hidden="true" className="size-4" />
									{copy.view}
								</a>
							</Button>
							<Button asChild size="lg">
								<a href={completedDocument.downloadUrl}>
									<Download aria-hidden="true" className="size-4" />
									{copy.download}
								</a>
							</Button>
						</div>
					</div>
				</Panel>
			)}
			{!session && !error && !completedDocument && (
				<LoadingText boxed>
					<span className="block font-medium text-foreground">{copy.loading}</span>
				</LoadingText>
			)}
			{session && (
				<>
					<div className="grid items-start gap-10 border-t border-foreground pt-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)] lg:gap-12">
						<SigningDocumentPreview
							session={session}
							canDragFields={session.signingMode === "only_me"}
							onStartFieldDrag={startFieldDrag}
							onContinueFieldDrag={continueFieldDrag}
							onStopFieldDrag={stopFieldDrag}
						/>
						<div id="signer-fields" className="scroll-mt-6 space-y-6 lg:sticky lg:top-8">
							<div className="space-y-3">
								<h2 className="font-serif text-3xl font-normal leading-tight">
									{copy.fill}
									<span className="text-destructive">.</span>
								</h2>
							</div>
							{session.fields.length === 0 ? (
								<div className="space-y-1 border-t pt-4">
									<p>{copy.noFields}</p>
									{session.signingMode !== "only_me" && (
										<p className="text-sm text-muted-foreground">{copy.noFieldsHelp}</p>
									)}
								</div>
							) : (
								<details className="border-t border-foreground">
									<summary className="cursor-pointer py-3 font-mono text-xs uppercase tracking-wide">
										{copy.contractFields}
									</summary>
									<Panel className="grid gap-0 border-x-0 border-b-0 border-t border-foreground bg-transparent p-0 shadow-none sm:p-0">
										{session.fields.map((field) => (
											<div
												key={field.id}
												className="flex items-baseline justify-between gap-4 border-b py-3"
											>
												<p>{signerFieldLabel(field, language)}</p>
												<p className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground tabular-nums">
													{copy.page} {field.page}
												</p>
											</div>
										))}
									</Panel>
								</details>
							)}
							<PartnerSignatureForm
								key={session.signaturePreference?.id ?? "new-partner-signature"}
								initialPreference={session.signaturePreference}
								fields={session.fields}
								disabled={changeRequested || session.fields.length === 0}
								onSubmit={completeSigning}
							/>
						</div>
					</div>
					{session.signingMode !== "only_me" && (
						<details className="space-y-6 border-t pt-7">
							<summary className="cursor-pointer font-mono text-xs uppercase tracking-wide">
								{copy.more}
							</summary>
							<form onSubmit={requestChanges} className="grid gap-4 md:grid-cols-3">
								<div className="space-y-2 md:col-span-2">
									<Label htmlFor="changeComment">{copy.change}</Label>
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
										{copy.requestChange}
									</Button>
								</div>
							</form>
							<form onSubmit={declineSigning} className="grid gap-4 md:grid-cols-3">
								<div className="space-y-2">
									<Label htmlFor="declineReason">{copy.declineReason}</Label>
									<Input
										id="declineReason"
										value={reason}
										onChange={(event) => setReason(event.target.value)}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="declineComment">{copy.comment}</Label>
									<Input
										id="declineComment"
										value={comment}
										onChange={(event) => setComment(event.target.value)}
									/>
								</div>
								<div className="flex items-end">
									<Button type="submit" variant="outline" className="w-full">
										<X className="h-4 w-4" />
										{copy.decline}
									</Button>
								</div>
							</form>
						</details>
					)}
				</>
			)}
			{message && (
				<output className="block text-muted-foreground text-sm">
					{message === "saveFailed" && completionError
						? signingError(language, completionError)
						: copy[message]}
				</output>
			)}
		</PageShell>
	);
	return (
		<>
			{verification && (
				<SigningVerificationPage
					token={verification.token}
					emailHint={verification.emailHint}
					onVerified={() => void refreshSigningState()}
				/>
			)}
			<Activity mode={verification ? "hidden" : "visible"}>{content}</Activity>
		</>
	);
}

function signingEndpoint(props: SignerPageProps) {
	return "historyEnvelopeId" in props
		? `/api/history/documents/${encodeURIComponent(props.historyEnvelopeId)}/signing`
		: `/api/signing/${encodeURIComponent(props.token)}`;
}

function SigningAccessError({
	error,
	language,
}: {
	error: SigningError;
	language: SigningLanguage;
}) {
	return (
		<Alert variant="destructive" role="alert">
			<AlertTitle>{signingError(language, error.code)}</AlertTitle>
			{error.verificationUrl && (
				<AlertDescription>
					<TextLink href={error.verificationUrl}>{signingCopy[language].verifyEmail}</TextLink>
				</AlertDescription>
			)}
		</Alert>
	);
}

function personalVerification(props: SignerPageProps, error: SigningError | null) {
	return "token" in props && error?.code === "PARTNER_VERIFICATION_REQUIRED"
		? { token: props.token, emailHint: error.emailHint }
		: null;
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
