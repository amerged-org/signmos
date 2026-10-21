import { PDFDocument } from "pdf-lib";
import {
	MAX_DOCUMENT_FIELDS,
	MAX_SOURCE_PDF_BYTES,
	MAX_SOURCE_PDF_PAGES,
} from "./pdf-policy-limits";

export {
	MAX_DOCUMENT_FIELDS,
	MAX_SOURCE_PDF_BYTES,
	MAX_SOURCE_PDF_PAGES,
} from "./pdf-policy-limits";

export class PdfPolicyError extends Error {
	constructor(
		public readonly code:
			| "INVALID_SOURCE_PDF"
			| "SOURCE_PDF_TOO_LARGE"
			| "SOURCE_PDF_TOO_MANY_PAGES"
			| "SOURCE_PDF_TOO_MANY_FIELDS",
		message: string,
		public readonly status: 400 | 413 = 400,
	) {
		super(message);
		this.name = "PdfPolicyError";
	}
}

export async function validateSourcePdf(bytes: Uint8Array): Promise<void> {
	await loadValidatedSourcePdf(bytes);
}

export async function loadValidatedSourcePdf(bytes: Uint8Array): Promise<PDFDocument> {
	if (bytes.byteLength > MAX_SOURCE_PDF_BYTES) {
		throw new PdfPolicyError("SOURCE_PDF_TOO_LARGE", "Source PDF must be at most 2 MiB", 413);
	}
	try {
		const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
		const pageCount = pdf.getPageCount();
		if (pageCount === 0) throw new Error("PDF has no pages");
		if (pageCount > MAX_SOURCE_PDF_PAGES) {
			throw new PdfPolicyError(
				"SOURCE_PDF_TOO_MANY_PAGES",
				"Source PDF must have at most 10 pages",
				413,
			);
		}
		return pdf;
	} catch (error) {
		if (error instanceof PdfPolicyError) throw error;
		throw new PdfPolicyError(
			"INVALID_SOURCE_PDF",
			"Upload a valid, unencrypted PDF with at least one page",
		);
	}
}

export function assertPdfFieldCount(count: number): void {
	if (!Number.isInteger(count) || count < 0 || count > MAX_DOCUMENT_FIELDS) {
		throw new PdfPolicyError(
			"SOURCE_PDF_TOO_MANY_FIELDS",
			"A document can have at most 20 signing fields",
			413,
		);
	}
}
