import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FileText, FileUp, UploadCloud } from "lucide-react";
import { type DragEvent, type FormEvent, useMemo, useRef, useState } from "react";
import { LoadingText } from "@/components/patterns/loading-text";
import { Panel, PanelDescription, PanelTitle } from "@/components/patterns/panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_SOURCE_PDF_BYTES, MAX_SOURCE_PDF_PAGES } from "@/db/envelope/pdf-policy-limits";
import { cn } from "@/lib/utils";
import type { SourcePdfUploadPanelProps } from "./source-pdf-upload-panel";

export type SourceDocumentResponse = {
	id: string;
	envelopeId: string;
	r2Key: string;
	version: number;
	sha256: string;
	byteSize: number;
	contentType: "application/pdf";
	originalFilename: string;
	uploadedBy: string;
	uploadedAt: string;
	selfSign?: {
		recipientId: string;
		signingUrl: string;
		fieldCount: number;
		fieldPage: number;
	};
};

type UploadSuccess = { data: SourceDocumentResponse };
type UploadError = { error: { message: string } };
type SourcePdfResponse = {
	data?: SourceDocumentResponse;
	error?: {
		code?: string;
		message?: string;
	};
};

export type SourcePdfStatus =
	| { status: "ready"; document: SourceDocumentResponse }
	| { status: "missing"; message: string };

export function UploadSourcePdfForm({
	envelopeId,
	senderSessionToken,
	signingMode,
	historyAccess = false,
}: SourcePdfUploadPanelProps) {
	const [file, setFile] = useState<File | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [uploadValidationError, setUploadValidationError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const queryClient = useQueryClient();
	const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
	const sourcePdfQuery = useSourcePdfQuery(envelopeId, senderSessionToken, historyAccess);
	const uploadMutation = useMutation({
		mutationFn: (selectedFile: File) =>
			uploadSourcePdf({
				envelopeId,
				senderSessionToken,
				historyAccess,
				idempotencyKey,
				file: selectedFile,
			}),
		onSuccess: (document) => {
			queryClient.setQueryData(sourcePdfQueryKey(envelopeId, senderSessionToken, historyAccess), {
				status: "ready",
				document,
			});
			setFile(null);
			setUploadValidationError(null);
			clearFileInput();
		},
	});
	const uploadError =
		uploadValidationError ??
		(uploadMutation.error instanceof Error ? uploadMutation.error.message : null);
	const uploadButtonLabel = getUploadButtonLabel(uploadMutation.isPending, Boolean(file));
	const currentDocument =
		uploadMutation.data ??
		(sourcePdfQuery.data?.status === "ready" ? sourcePdfQuery.data.document : null);
	const selfSign = signingMode === "only_me" ? currentDocument?.selfSign : undefined;

	function clearFileInput() {
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	}

	function selectFile(nextFile: File | null) {
		uploadMutation.reset();
		if (!nextFile) {
			setFile(null);
			setUploadValidationError(null);
			return;
		}
		if (!isPdfFile(nextFile)) {
			setFile(null);
			setUploadValidationError("Select a PDF file.");
			clearFileInput();
			return;
		}
		if (nextFile.size > MAX_SOURCE_PDF_BYTES) {
			setFile(null);
			setUploadValidationError(`Select a PDF up to ${MAX_SOURCE_PDF_BYTES / 1024 / 1024} MB.`);
			clearFileInput();
			return;
		}
		setFile(nextFile);
		setUploadValidationError(null);
	}

	function handleDrop(event: DragEvent<HTMLLabelElement>) {
		event.preventDefault();
		setIsDragging(false);
		selectFile(event.dataTransfer.files.item(0));
	}

	function handleDragOver(event: DragEvent<HTMLLabelElement>) {
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		setIsDragging(true);
	}

	function submitUpload(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!file) return;

		setUploadValidationError(null);
		uploadMutation.mutate(file);
	}

	return (
		<Panel as="form" aria-label="Upload source PDF" onSubmit={submitUpload}>
			<div className="space-y-5">
				<div className="space-y-3">
					<div>
						<PanelTitle>Source PDF</PanelTitle>
						<PanelDescription>Select the PDF document to prepare for signing.</PanelDescription>
					</div>
					<Input
						id="source-pdf"
						ref={fileInputRef}
						type="file"
						aria-invalid={Boolean(uploadError)}
						aria-label="Choose PDF"
						accept="application/pdf"
						className="peer sr-only"
						onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
					/>
					<Label
						htmlFor="source-pdf"
						className={cn(
							"flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed bg-muted/20 p-6 text-center transition-colors",
							"hover:border-ring/50 hover:bg-muted/40",
							"peer-focus-visible:border-ring peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50",
							isDragging && "border-ring bg-muted/40 ring-[3px] ring-ring/50",
							uploadError && "border-destructive bg-destructive/5",
						)}
						onDragLeave={() => setIsDragging(false)}
						onDragOver={handleDragOver}
						onDrop={handleDrop}
					>
						<span className="mb-3 flex size-12 items-center justify-center rounded-full bg-background">
							<UploadCloud aria-hidden="true" className="size-6 text-muted-foreground" />
						</span>
						<span className="font-medium text-base">{file ? "PDF selected" : "Choose PDF"}</span>
						<span className="mt-1 text-muted-foreground text-pretty text-sm">
							Click here or drag a PDF into this area.
						</span>
						<span className="mt-3 rounded-md bg-background px-2 py-1 text-muted-foreground text-xs">
							PDF only, up to {MAX_SOURCE_PDF_BYTES / 1024 / 1024} MB and {MAX_SOURCE_PDF_PAGES}{" "}
							pages
						</span>
					</Label>
					{file ? <SelectedPdf file={file} /> : null}
				</div>

				{uploadError ? (
					<Alert variant="destructive" role="alert">
						<AlertTitle>Upload failed</AlertTitle>
						<AlertDescription>{uploadError}</AlertDescription>
					</Alert>
				) : null}

				{sourcePdfQuery.isLoading ? <LoadingText>Checking existing PDF…</LoadingText> : null}

				{currentDocument ? (
					<Alert>
						<AlertTitle>PDF uploaded</AlertTitle>
						<AlertDescription className="tabular-nums">
							Version {currentDocument.version} · {currentDocument.byteSize} bytes ·{" "}
							<span className="font-mono">{currentDocument.sha256}</span>
						</AlertDescription>
					</Alert>
				) : null}

				{selfSign ? (
					<SelfSignPreviewAndAction
						envelopeId={envelopeId}
						senderSessionToken={senderSessionToken}
						historyAccess={historyAccess}
						fieldPage={selfSign.fieldPage}
						signingUrl={selfSign.signingUrl}
					/>
				) : null}

				<Button type="submit" disabled={uploadMutation.isPending || !file}>
					<FileUp aria-hidden="true" className="size-4" />
					{uploadButtonLabel}
				</Button>
			</div>
		</Panel>
	);
}

function getUploadButtonLabel(isPending: boolean, hasFile: boolean) {
	if (isPending) return "Uploading…";
	return hasFile ? "Upload selected PDF" : "Select a PDF first";
}

function SelfSignPreviewAndAction({
	envelopeId,
	senderSessionToken,
	fieldPage,
	signingUrl,
	historyAccess,
}: {
	envelopeId: string;
	senderSessionToken: string;
	fieldPage: number;
	signingUrl: string;
	historyAccess: boolean;
}) {
	return (
		<section className="space-y-3 rounded-lg border bg-muted/20 p-4" aria-label="PDF preview">
			<div>
				<h3 className="text-balance font-medium text-base">Preview</h3>
				<p className="text-pretty text-muted-foreground text-sm">
					Review the uploaded PDF before signing.
				</p>
			</div>
			<iframe
				className="aspect-[612/792] w-full rounded-md border bg-white"
				src={buildPreviewUrl(envelopeId, senderSessionToken, fieldPage, historyAccess)}
				title="Uploaded source PDF preview"
			/>
			<Button asChild>
				<a href={signingUrl}>
					Continue to sign
					<ArrowRight aria-hidden="true" className="size-4" />
				</a>
			</Button>
		</section>
	);
}

function SelectedPdf({ file }: { file: File }) {
	return (
		<div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
			<FileText aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
			<div className="min-w-0">
				<p className="truncate font-medium text-sm">{file.name}</p>
				<p className="text-muted-foreground text-xs tabular-nums">{formatBytes(file.size)}</p>
			</div>
		</div>
	);
}

function buildPreviewUrl(
	envelopeId: string,
	senderSessionToken: string,
	page: number,
	historyAccess: boolean,
) {
	const params = historyAccess
		? new URLSearchParams({ historyAccess: "true" })
		: new URLSearchParams({ senderSessionToken });
	return `/api/envelopes/${envelopeId}/source-pdf/content?${params.toString()}#toolbar=0&navpanes=0&scrollbar=0&page=${page}`;
}

function sourcePdfQueryKey(envelopeId: string, senderSessionToken: string, historyAccess = false) {
	return ["source-pdf", envelopeId, historyAccess ? "history" : senderSessionToken] as const;
}

export function useSourcePdfQuery(
	envelopeId: string,
	senderSessionToken: string,
	historyAccess = false,
) {
	return useQuery({
		queryKey: sourcePdfQueryKey(envelopeId, senderSessionToken, historyAccess),
		queryFn: () => fetchSourcePdf(envelopeId, senderSessionToken, historyAccess),
		staleTime: 30_000,
	});
}

async function fetchSourcePdf(
	envelopeId: string,
	senderSessionToken: string,
	historyAccess = false,
): Promise<SourcePdfStatus> {
	const response = await fetch(`/api/envelopes/${envelopeId}/source-pdf`, {
		headers: historyAccess
			? { "x-history-session-access": "true" }
			: { "x-sender-session-token": senderSessionToken },
	});
	const json = (await response.json().catch((): SourcePdfResponse => ({}))) as
		| SourcePdfResponse
		| undefined;
	if (response.status === 404 && json?.error?.code === "SOURCE_PDF_NOT_FOUND") {
		return {
			status: "missing",
			message:
				json.error.message ?? "Upload a source PDF before preparing or sending this envelope",
		};
	}
	if (!response.ok || !json?.data) {
		throw new Error(json?.error?.message ?? "Unable to check the source PDF");
	}
	return { status: "ready", document: json.data };
}

async function uploadSourcePdf(input: {
	envelopeId: string;
	senderSessionToken: string;
	historyAccess?: boolean;
	idempotencyKey: string;
	file: File;
}): Promise<SourceDocumentResponse> {
	const response = await fetch(`/api/envelopes/${input.envelopeId}/source-pdf`, {
		method: "POST",
		headers: {
			"content-type": input.file.type || "application/pdf",
			"idempotency-key": input.idempotencyKey,
			"x-source-filename": encodeURIComponent(input.file.name),
			...(input.historyAccess
				? { "x-history-session-access": "true" }
				: { "x-sender-session-token": input.senderSessionToken }),
		},
		body: input.file,
	});
	const json: unknown = await response.json().catch(() => null);
	if (!response.ok || !isUploadSuccess(json)) {
		const message = isUploadError(json) ? json.error.message : "Unable to upload the PDF";
		throw new Error(message);
	}
	return json.data;
}

function isPdfFile(file: File) {
	return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	const kib = bytes / 1024;
	if (kib < 1024) return `${formatNumber(kib)} KB`;
	return `${formatNumber(kib / 1024)} MB`;
}

function formatNumber(value: number) {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function isUploadSuccess(value: unknown): value is UploadSuccess {
	if (!value || typeof value !== "object" || !("data" in value)) return false;
	const data = value.data;
	return Boolean(data && typeof data === "object" && "sha256" in data);
}

function isUploadError(value: unknown): value is UploadError {
	if (!value || typeof value !== "object" || !("error" in value)) return false;
	const error = value.error;
	return Boolean(error && typeof error === "object" && "message" in error);
}
