import { type PDFDocument, StandardFonts } from "pdf-lib";
import {
	assertPdfFieldCount,
	loadValidatedSourcePdf,
	MAX_SOURCE_PDF_PAGES,
	PdfPolicyError,
} from "@/db/envelope/pdf-policy";
import { isPdf } from "@/hono/api/envelope-route-helpers";
import {
	ContractError,
	type ContractField,
	type CreateContractRequest,
	MAX_CONTRACT_PDF_BYTES,
} from "./contracts-schema";

export async function prepareContractPdf(
	request: CreateContractRequest,
): Promise<{ bytes: Uint8Array; fields: ContractField[] }> {
	const bytes = decodePdf(request.pdf.base64);
	const pdf = await loadContractPdf(bytes, request.fields?.length ?? 2);
	if (request.fields) {
		if (request.fields.some((field) => field.page > pdf.getPageCount())) {
			throw new ContractError("INVALID_FIELDS", "A field references a page that does not exist");
		}
		return { bytes, fields: request.fields };
	}
	if (pdf.getPageCount() >= MAX_SOURCE_PDF_PAGES) {
		throw new ContractError(
			"SOURCE_PDF_TOO_MANY_PAGES",
			"Default placement requires at most 9 source pages so the signing page fits within 10 pages",
			413,
		);
	}
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const page = pdf.addPage([612, 792]);
	page.drawText("Contract signature", { x: 72, y: 720, size: 22, font });
	page.drawText("Sign below to confirm the preceding document.", { x: 72, y: 680, size: 12, font });
	page.drawText("Signature", { x: 72, y: 490, size: 11, font });
	page.drawText("Date", { x: 72, y: 370, size: 11, font });
	const prepared = await pdf.save();
	if (prepared.byteLength > MAX_CONTRACT_PDF_BYTES) {
		throw new ContractError(
			"SOURCE_PDF_TOO_LARGE",
			"The PDF including its signing page must be at most 2 MiB",
			413,
		);
	}
	const pageNumber = pdf.getPageCount();
	return {
		bytes: prepared,
		fields: [
			{ type: "signature", page: pageNumber, x: 72, y: 320, width: 280, height: 70 },
			{ type: "date", page: pageNumber, x: 72, y: 440, width: 180, height: 35 },
		],
	};
}

async function loadContractPdf(bytes: Uint8Array, fieldCount: number): Promise<PDFDocument> {
	try {
		assertPdfFieldCount(fieldCount);
		return await loadValidatedSourcePdf(bytes);
	} catch (error) {
		if (error instanceof PdfPolicyError)
			throw new ContractError(error.code, error.message, error.status);
		throw error;
	}
}

function decodePdf(base64: string): Uint8Array {
	if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
		throw new ContractError(
			"INVALID_SOURCE_PDF",
			"pdf.base64 must contain standard base64 without a data URL prefix",
		);
	}
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	if ((base64.length / 4) * 3 - padding > MAX_CONTRACT_PDF_BYTES)
		throw new ContractError("SOURCE_PDF_TOO_LARGE", "The source PDF must be at most 2 MiB", 413);
	// A Worker has 50 ms of CPU per request: a per-byte callback over 2 MiB costs about 90 ms,
	// the native decoder about 1 ms. The copy gives the bytes their own exactly sized buffer.
	const bytes = new Uint8Array(Buffer.from(base64, "base64"));
	if (!isPdf(bytes)) throw new ContractError("INVALID_SOURCE_PDF", "Source document must be a PDF");
	return bytes;
}
