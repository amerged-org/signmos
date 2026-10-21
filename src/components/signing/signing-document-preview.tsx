import { FileText } from "lucide-react";
import { pdfPage } from "@/components/envelopes/field-placement-workspace";
import { useNoncePositionStyle } from "@/components/nonce-position-style";
import { TextLink } from "@/components/patterns/text-link";
import { cn } from "@/lib/utils";
import type { PartnerSignaturePreference } from "./partner-signature-form";

export interface SignerField {
	id: string;
	type: "signature" | "date";
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
	const previewFields = signerPreviewFields(session);
	const pages = previewPages(previewFields);

	return (
		<section className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-balance font-semibold text-xl">Dein Vertrag</h2>
				<TextLink
					className="inline-flex items-center gap-2 text-sm"
					href={session.sourceDocument.downloadUrl}
				>
					<FileText aria-hidden="true" className="size-4" />
					PDF öffnen
				</TextLink>
			</div>
			<div className="grid gap-4">
				{pages.map((page, index) => (
					<fieldset
						key={page}
						aria-label={`Vertrag Seite ${page}`}
						data-signing-pdf-page
						className="relative aspect-[612/792] w-full overflow-hidden rounded-md border bg-white"
						onPointerMove={onContinueFieldDrag}
						onPointerUp={onStopFieldDrag}
						onPointerLeave={onStopFieldDrag}
						onMouseMove={onContinueFieldDrag}
						onMouseUp={onStopFieldDrag}
						onMouseLeave={onStopFieldDrag}
					>
						<legend className="sr-only">Vertrag Seite {page}</legend>
						<iframe
							className="absolute inset-0 h-full w-full bg-muted"
							src={pdfPreviewUrl(session.sourceDocument.downloadUrl, page)}
							title={index === 0 ? "Vertragsvorschau" : `Vertragsvorschau Seite ${page}`}
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
	const hasValue = Boolean(field.value?.trim());
	const isDraggable = canDrag && field.assignedToCurrentSigner && !hasValue;
	const position = useNoncePositionStyle(field, pdfPage);
	const className = cn(
		"absolute flex overflow-hidden rounded border-2 px-2 text-slate-950 shadow-sm",
		position.className,
		hasValue ? "border-emerald-700 bg-white/90" : "border-blue-700 bg-blue-50/90",
		field.assignedToCurrentSigner && !hasValue && "border-dashed",
		isDraggable && "pointer-events-auto cursor-move",
		field.height < 40 ? "items-center text-[10px]" : "flex-col justify-center text-xs",
	);
	const content = field.value ? (
		<PreviewFieldValue field={field} value={field.value} />
	) : (
		<>
			<span className="truncate font-medium capitalize">
				{field.type === "signature" ? "Hier unterschreiben" : "Datum"}
			</span>
			<span className="truncate">{field.recipientName}</span>
		</>
	);
	if (isDraggable) {
		return (
			<>
				{position.styles}
				<button
					aria-label={`${field.recipientName} · ${field.type === "signature" ? "Unterschrift" : "Datum"} · Feld`}
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
				aria-label={`${field.recipientName} · ${field.type === "signature" ? "Unterschrift" : "Datum"} · ${hasValue ? "ausgefüllt" : "Feld"}`}
				role="img"
				className={className}
			>
				{content}
			</div>
		</>
	);
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

function signerPreviewFields(session: SignerSession): SignerPreviewField[] {
	if (session.previewFields?.length) return session.previewFields;
	return session.fields.map((field) => ({
		...field,
		recipientId: session.recipientId,
		recipientName: "Unterzeichner",
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
	return /^[MmLlHhVvCcSsQqTtAaZz0-9,.\s-]+$/.test(value.trim());
}
