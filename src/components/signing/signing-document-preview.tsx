import { FileText } from "lucide-react";
import { pdfPage } from "@/components/envelopes/field-placement-workspace";
import { useNoncePositionStyle } from "@/components/nonce-position-style";
import { TextLink } from "@/components/patterns/text-link";
import { useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { PartnerSignaturePreference } from "./partner-signature-form";
import { type SigningLanguage, signingCopy } from "./signing-copy";

export interface SignerField {
	id: string;
	type: "signature" | "date" | "text" | "checkbox";
	name?: string | null;
	label?: string | null;
	required?: boolean;
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SignerPreviewField extends SignerField {
	recipientId: string;
	recipientName: string;
	value: string | null;
	assignedToCurrentSigner: boolean;
}

export interface SignerSession {
	envelopeId: string;
	recipientId: string;
	signingMode?: "only_me" | "me_and_another_signer";
	sourceDocument: {
		version: number;
		contentType: "application/pdf";
		downloadUrl: string;
	};
	fields: SignerField[];
	previewFields?: SignerPreviewField[];
	signaturePreference: PartnerSignaturePreference | null;
}

export function SigningDocumentPreview({
	session,
	canDragFields,
	onStartFieldDrag,
	onContinueFieldDrag,
	onStopFieldDrag,
}: {
	session: SignerSession;
	canDragFields: boolean;
	onStartFieldDrag: (
		event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>,
		field: SignerPreviewField,
	) => void;
	onContinueFieldDrag: (
		event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>,
	) => void;
	onStopFieldDrag: () => void;
}) {
	const { language } = useLanguage();
	const copy = signingCopy[language];
	const previewFields = signerPreviewFields(session, language);
	const pages = previewPages(previewFields);

	return (
		<section className="min-w-0 space-y-5" aria-label={copy.contractFields}>
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-3">
					<p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
						<span className="mr-2 text-destructive">01 /</span> {copy.document}
					</p>
					<h2 className="font-serif text-3xl font-normal leading-tight">
						{copy.yourContract}
						<span className="text-destructive">.</span>
					</h2>
				</div>
				<TextLink
					className="inline-flex items-center gap-2 text-sm underline underline-offset-4"
					href={session.sourceDocument.downloadUrl}
				>
					<FileText aria-hidden="true" className="size-4" />
					{copy.openPdf}
				</TextLink>
			</div>
			<div className="space-y-3">
				<p className="text-sm leading-6 text-muted-foreground">{copy.readContract}</p>
				<iframe
					className="h-[70vh] min-h-[400px] w-full border border-border bg-muted"
					src={`${session.sourceDocument.downloadUrl}#view=FitH`}
					title={copy.fullContract}
				/>
			</div>
			<details open={canDragFields || undefined} className="space-y-4 border-t pt-4">
				<summary className="cursor-pointer font-serif text-xl">{copy.contractFields}</summary>
				<div className="grid gap-4">
					{pages.map((page, index) => (
						<fieldset
							key={page}
							aria-label={`${copy.contractPage} ${page}`}
							data-signing-pdf-page
							className="relative aspect-[612/792] w-full overflow-hidden border border-border bg-background"
							onPointerMove={onContinueFieldDrag}
							onPointerUp={onStopFieldDrag}
							onPointerLeave={onStopFieldDrag}
							onMouseMove={onContinueFieldDrag}
							onMouseUp={onStopFieldDrag}
							onMouseLeave={onStopFieldDrag}
						>
							<legend className="sr-only">
								{copy.contractPage} {page}
							</legend>
							<iframe
								className="absolute inset-0 h-full w-full bg-muted"
								src={pdfPreviewUrl(session.sourceDocument.downloadUrl, page)}
								title={index === 0 ? copy.preview : `${copy.preview} ${copy.page} ${page}`}
							/>
							<div className="pointer-events-none absolute inset-0">
								{previewFields
									.filter((field) => field.page === page)
									.map((field) => (
										<SigningPreviewFieldOverlay
											key={field.id}
											field={field}
											canDrag={canDragFields}
											onStartDrag={onStartFieldDrag}
										/>
									))}
							</div>
						</fieldset>
					))}
				</div>
			</details>
		</section>
	);
}

function SigningPreviewFieldOverlay({
	field,
	canDrag,
	onStartDrag,
}: {
	field: SignerPreviewField;
	canDrag: boolean;
	onStartDrag: (
		event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>,
		field: SignerPreviewField,
	) => void;
}) {
	const { language } = useLanguage();
	const copy = signingCopy[language];
	const hasValue = Boolean(field.value?.trim());
	const isDraggable = canDrag && field.assignedToCurrentSigner && !hasValue;
	const position = useNoncePositionStyle(field, pdfPage);
	const className = cn(
		"absolute flex overflow-hidden border-2 px-2 text-foreground",
		position.className,
		hasValue ? "border-foreground bg-background/95" : "border-destructive bg-background/95",
		field.assignedToCurrentSigner && !hasValue && "border-dashed",
		isDraggable && "pointer-events-auto cursor-move",
		field.height < 40 ? "items-center text-[10px]" : "flex-col justify-center text-xs",
	);
	const content = field.value ? (
		<PreviewFieldValue field={field} value={field.value} />
	) : (
		<>
			<span className="truncate font-medium capitalize">
				{field.type === "signature" ? copy.signHere : signerFieldLabel(field, language)}
			</span>
			<span className="truncate">{field.recipientName}</span>
		</>
	);
	if (isDraggable) {
		return (
			<>
				{position.styles}
				<button
					aria-label={`${field.recipientName} · ${signerFieldLabel(field, language)} · ${copy.field}`}
					type="button"
					className={className}
					onPointerDown={(event) => onStartDrag(event, field)}
					onMouseDown={(event) => onStartDrag(event, field)}
				>
					{content}
				</button>
			</>
		);
	}
	return (
		<>
			{position.styles}
			<div
				aria-label={`${field.recipientName} · ${signerFieldLabel(field, language)} · ${hasValue ? copy.filled : copy.field}`}
				role="img"
				className={className}
			>
				{content}
			</div>
		</>
	);
}

export function signerFieldLabel(field: SignerField, language: SigningLanguage = "de"): string {
	if (field.label) return field.label;
	if (field.name) return field.name;
	return signingCopy[language][field.type];
}

function PreviewFieldValue({ field, value }: { field: SignerPreviewField; value: string }) {
	if (field.type === "signature" && looksLikeSvgPath(value)) {
		return (
			<svg aria-hidden="true" className="h-full w-full" viewBox="0 0 320 128">
				<path d={value} fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="4" />
			</svg>
		);
	}
	return (
		<>
			<span className="truncate font-medium">{value}</span>
			<span className="truncate text-[10px]">{field.recipientName}</span>
		</>
	);
}

function signerPreviewFields(
	session: SignerSession,
	language: SigningLanguage,
): SignerPreviewField[] {
	if (session.previewFields?.length) return session.previewFields;
	return session.fields.map((field) => ({
		...field,
		recipientId: session.recipientId,
		recipientName: signingCopy[language].signer,
		value: null,
		assignedToCurrentSigner: true,
	}));
}

function previewPages(fields: SignerPreviewField[]): number[] {
	const pages = [...new Set(fields.map((field) => field.page))].sort((left, right) => left - right);
	return pages.length > 0 ? pages : [1];
}

function pdfPreviewUrl(downloadUrl: string, page: number): string {
	return `${downloadUrl}#toolbar=0&navpanes=0&scrollbar=0&page=${page}`;
}

function looksLikeSvgPath(value: string): boolean {
	return /^[Mm]\s*-?(?:\d+\.?\d*|\.\d+)[,\s]+-?(?:\d+\.?\d*|\.\d+)(?:[MmLlHhVvCcSsQqTtAaZz0-9,.\s-]*)$/.test(
		value.trim(),
	);
}
