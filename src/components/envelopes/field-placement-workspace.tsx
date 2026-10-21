import { CheckCircle2, Circle, Save } from "lucide-react";
import type { MouseEvent, PointerEvent, RefObject } from "react";
import { useNoncePositionStyle } from "@/components/nonce-position-style";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FieldEditorRecipient {
	id: string;
	name: string;
	email: string;
}

type FieldType = "signature" | "date";

export type PlacedField = {
	recipientId: string;
	type: FieldType;
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type EnvelopeFieldResponse = PlacedField & {
	id: string;
	envelopeId: string;
	createdAt: string;
};

export const pdfPage = {
	width: 612,
	height: 792,
} as const;

export const signatureDimensions = { width: 180, height: 48 } as const;

type FieldPlacementWorkspaceProps = {
	values: PlacedField;
	recipients: FieldEditorRecipient[];
	signatureRecipientIds: Set<string>;
	placedFields: EnvelopeFieldResponse[];
	sourcePdfPreviewUrl?: string;
	allSignaturesPlaced: boolean;
	isSaving: boolean;
	isSaveError: boolean;
	previewRef: RefObject<HTMLFieldSetElement | null>;
	onSelectRecipient: (recipientId: string) => void;
	onSubmit: () => void;
	onStartDragging: (
		event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>,
		field: PlacedField,
	) => void;
	onContinueDragging: (
		event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>,
		field: PlacedField,
	) => void;
	onStopDragging: () => void;
};

export function FieldPlacementWorkspace({
	values,
	recipients,
	signatureRecipientIds,
	placedFields,
	sourcePdfPreviewUrl,
	allSignaturesPlaced,
	isSaving,
	isSaveError,
	previewRef,
	onSelectRecipient,
	onSubmit,
	onStartDragging,
	onContinueDragging,
	onStopDragging,
}: FieldPlacementWorkspaceProps) {
	const activeRecipient = getActiveRecipient(recipients, signatureRecipientIds, values.recipientId);
	const currentField = activeRecipient
		? buildNextSignatureField(values, recipients, signatureRecipientIds, placedFields)
		: null;

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
			<PdfPlacementPreview
				recipients={recipients}
				placedFields={placedFields}
				currentField={currentField}
				sourcePdfPreviewUrl={sourcePdfPreviewUrl}
				activeRecipientName={activeRecipient?.name ?? "Signer"}
				allSignaturesPlaced={allSignaturesPlaced}
				previewRef={previewRef}
				onStartDragging={onStartDragging}
				onContinueDragging={onContinueDragging}
				onStopDragging={onStopDragging}
			/>
			<SignaturePlacementActions
				recipients={recipients}
				activeRecipient={activeRecipient}
				signatureRecipientIds={signatureRecipientIds}
				isSaving={isSaving}
				isSaveError={isSaveError}
				allSignaturesPlaced={allSignaturesPlaced}
				onSelectRecipient={onSelectRecipient}
				onSubmit={onSubmit}
			/>
		</div>
	);
}

function PdfPlacementPreview({
	recipients,
	placedFields,
	currentField,
	sourcePdfPreviewUrl,
	activeRecipientName,
	allSignaturesPlaced,
	previewRef,
	onStartDragging,
	onContinueDragging,
	onStopDragging,
}: {
	recipients: FieldEditorRecipient[];
	placedFields: EnvelopeFieldResponse[];
	currentField: PlacedField | null;
	sourcePdfPreviewUrl?: string;
	activeRecipientName: string;
	allSignaturesPlaced: boolean;
	previewRef: RefObject<HTMLFieldSetElement | null>;
	onStartDragging: (
		event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>,
		field: PlacedField,
	) => void;
	onContinueDragging: (
		event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>,
		field: PlacedField,
	) => void;
	onStopDragging: () => void;
}) {
	return (
		<div>
			<fieldset
				ref={previewRef}
				aria-label="PDF page preview"
				className="relative aspect-[612/792] w-full overflow-hidden rounded-lg border bg-white text-slate-950 shadow-sm"
				onPointerMove={(event) => currentField && onContinueDragging(event, currentField)}
				onPointerUp={onStopDragging}
				onPointerLeave={onStopDragging}
				onMouseMove={(event) => currentField && onContinueDragging(event, currentField)}
				onMouseUp={onStopDragging}
				onMouseLeave={onStopDragging}
			>
				<legend className="sr-only">PDF page preview</legend>
				{sourcePdfPreviewUrl ? (
					<iframe
						className="pointer-events-none absolute inset-0 z-0 h-full w-full border-0 bg-white"
						src={sourcePdfPreviewUrl}
						title="Uploaded source PDF preview"
					/>
				) : null}
				{placedFields.map((field, index) => (
					<FieldOverlay
						key={field.id}
						field={field}
						recipientName={getRecipientName(recipients, field.recipientId)}
						colorIndex={recipientColorIndex(recipients, field.recipientId, index)}
						isCurrent={false}
					/>
				))}
				{currentField ? (
					<FieldOverlay
						field={currentField}
						recipientName={activeRecipientName}
						colorIndex={recipientColorIndex(recipients, currentField.recipientId, 0)}
						isCurrent={true}
						onPointerDown={(event) => onStartDragging(event, currentField)}
						onMouseDown={(event) => onStartDragging(event, currentField)}
					/>
				) : null}
			</fieldset>
			<p className="mt-3 text-muted-foreground text-pretty text-sm">
				{allSignaturesPlaced
					? "All signers have signature placeholders."
					: "Drag the active signature box to the right spot, then save it for that signer."}
			</p>
		</div>
	);
}

function SignaturePlacementActions({
	recipients,
	activeRecipient,
	signatureRecipientIds,
	isSaving,
	isSaveError,
	allSignaturesPlaced,
	onSelectRecipient,
	onSubmit,
}: {
	recipients: FieldEditorRecipient[];
	activeRecipient: FieldEditorRecipient | null;
	signatureRecipientIds: Set<string>;
	isSaving: boolean;
	isSaveError: boolean;
	allSignaturesPlaced: boolean;
	onSelectRecipient: (recipientId: string) => void;
	onSubmit: () => void;
}) {
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onSubmit();
			}}
			className="space-y-4"
		>
			<RecipientPlacementList
				recipients={recipients}
				activeRecipientId={activeRecipient?.id ?? null}
				signatureRecipientIds={signatureRecipientIds}
				onSelect={onSelectRecipient}
			/>
			<Button
				type="submit"
				className="w-full"
				disabled={isSaving || allSignaturesPlaced || !activeRecipient}
			>
				<Save aria-hidden="true" className="size-4" />
				{signatureButtonLabel(isSaving, activeRecipient)}
			</Button>
			{isSaveError ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>Placement failed</AlertTitle>
					<AlertDescription>Unable to place signature</AlertDescription>
				</Alert>
			) : null}
		</form>
	);
}

function RecipientPlacementList({
	recipients,
	activeRecipientId,
	signatureRecipientIds,
	onSelect,
}: {
	recipients: FieldEditorRecipient[];
	activeRecipientId: string | null;
	signatureRecipientIds: Set<string>;
	onSelect: (recipientId: string) => void;
}) {
	return (
		<div className="space-y-2">
			<div>
				<h3 className="font-medium text-sm">Signers</h3>
				<p className="text-muted-foreground text-pretty text-sm">
					Each signer needs exactly one signature placeholder.
				</p>
			</div>
			<div className="space-y-2">
				{recipients.map((recipient, index) => {
					const isPlaced = signatureRecipientIds.has(recipient.id);
					const isActive = recipient.id === activeRecipientId;
					return (
						<button
							key={recipient.id}
							type="button"
							aria-label={`${recipient.name} signature status`}
							disabled={isPlaced}
							onClick={() => onSelect(recipient.id)}
							className={cn(
								"flex w-full items-start gap-3 rounded-lg border bg-background p-3 text-left transition-colors",
								"focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
								!isPlaced && "hover:bg-muted/40",
								isActive && "border-primary bg-muted/40",
								isPlaced && "cursor-default bg-muted/30",
							)}
						>
							<span className={cn("mt-0.5", recipientAccentText(index))}>
								{isPlaced ? (
									<CheckCircle2 aria-hidden="true" className="size-5" />
								) : (
									<Circle aria-hidden="true" className="size-5" />
								)}
							</span>
							<span className="min-w-0">
								<span className="block truncate font-medium text-sm">{recipient.name}</span>
								<span className="block truncate text-muted-foreground text-xs">
									{recipient.email}
								</span>
								<span className="mt-1 block text-xs">
									{isPlaced ? "Placed" : "Needs placement"}
								</span>
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function FieldOverlay({
	field,
	recipientName,
	colorIndex,
	isCurrent,
	onPointerDown,
	onMouseDown,
}: {
	field: PlacedField;
	recipientName: string;
	colorIndex: number;
	isCurrent: boolean;
	onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
	onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
}) {
	const isCompact = field.height < 40;
	const position = useNoncePositionStyle(field, pdfPage);
	const palette = recipientOverlayPalette(colorIndex);
	const className = cn(
		"absolute z-10 flex justify-center overflow-hidden rounded border-2 px-1 tabular-nums",
		position.className,
		palette,
		isCurrent && "cursor-move ring-2 ring-slate-950/20",
		isCompact ? "items-center text-[9px]" : "flex-col text-[10px] leading-tight",
	);
	const content = isCompact ? (
		<span className="truncate font-medium">
			{field.type} · {recipientName}
		</span>
	) : (
		<>
			<span className="truncate font-medium capitalize">{field.type}</span>
			<span className="truncate">{recipientName}</span>
		</>
	);
	if (isCurrent) {
		return (
			<>
				{position.styles}
				<button
					aria-label="Current signature placeholder"
					type="button"
					className={className}
					onPointerDown={onPointerDown}
					onMouseDown={onMouseDown}
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
				aria-label={`${recipientName} ${field.type} placeholder`}
				role="img"
				className={className}
			>
				{content}
			</div>
		</>
	);
}

export function buildNextSignatureField(
	values: PlacedField,
	recipients: FieldEditorRecipient[],
	signatureRecipientIds: Set<string>,
	placedFields: EnvelopeFieldResponse[] = [],
): PlacedField | null {
	const activeRecipient = getActiveRecipient(recipients, signatureRecipientIds, values.recipientId);
	if (!activeRecipient) return null;
	return moveFromOccupiedCoordinates(
		{
			...values,
			recipientId: activeRecipient.id,
			type: "signature",
			width: signatureDimensions.width,
			height: signatureDimensions.height,
		},
		placedFields,
	);
}

function moveFromOccupiedCoordinates(
	field: PlacedField,
	placedFields: EnvelopeFieldResponse[],
): PlacedField {
	const occupiedCoordinates = new Set(
		placedFields.map((placedField) => `${placedField.x}:${placedField.y}`),
	);
	if (!occupiedCoordinates.has(`${field.x}:${field.y}`)) return field;

	const gap = 24;
	let nextY = field.y + field.height + gap;
	while (nextY <= pdfPage.height - field.height) {
		if (!occupiedCoordinates.has(`${field.x}:${nextY}`)) {
			return {
				...field,
				y: nextY,
			};
		}
		nextY += field.height + gap;
	}

	let nextX = field.x + field.width + gap;
	while (nextX <= pdfPage.width - field.width) {
		if (!occupiedCoordinates.has(`${nextX}:${field.y}`)) {
			return {
				...field,
				x: nextX,
			};
		}
		nextX += field.width + gap;
	}

	const previousY = field.y - field.height - gap;
	if (previousY >= 0 && !occupiedCoordinates.has(`${field.x}:${previousY}`)) {
		return {
			...field,
			y: previousY,
		};
	}

	return {
		...field,
		y: Math.max(0, field.y - field.height - gap),
	};
}

function getActiveRecipient(
	recipients: FieldEditorRecipient[],
	signatureRecipientIds: Set<string>,
	preferredRecipientId: string,
): FieldEditorRecipient | null {
	return (
		recipients.find(
			(recipient) =>
				recipient.id === preferredRecipientId && !signatureRecipientIds.has(recipient.id),
		) ??
		recipients.find((recipient) => !signatureRecipientIds.has(recipient.id)) ??
		null
	);
}

function signatureButtonLabel(
	isSaving: boolean,
	activeRecipient: FieldEditorRecipient | null,
): string {
	if (isSaving) return "Saving…";
	return activeRecipient ? `Place ${activeRecipient.name} signature` : "All signatures placed";
}

function recipientColorIndex(
	recipients: FieldEditorRecipient[],
	recipientId: string,
	fallbackIndex: number,
): number {
	const index = recipients.findIndex((recipient) => recipient.id === recipientId);
	return index >= 0 ? index : fallbackIndex;
}

function recipientOverlayPalette(index: number): string {
	const palettes = [
		"border-blue-600 bg-blue-50 text-blue-950",
		"border-emerald-600 bg-emerald-50 text-emerald-950",
		"border-amber-600 bg-amber-50 text-amber-950",
		"border-rose-600 bg-rose-50 text-rose-950",
	];
	return palettes[index % palettes.length];
}

function recipientAccentText(index: number): string {
	const colors = ["text-blue-600", "text-emerald-600", "text-amber-600", "text-rose-600"];
	return colors[index % colors.length];
}

function getRecipientName(recipients: FieldEditorRecipient[], recipientId: string): string {
	return recipients.find((recipient) => recipient.id === recipientId)?.name ?? "Signer";
}
