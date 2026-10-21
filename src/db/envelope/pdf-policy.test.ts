import { PDFDocument } from "pdf-lib";
import {
	assertPdfFieldCount,
	MAX_DOCUMENT_FIELDS,
	MAX_SOURCE_PDF_BYTES,
	MAX_SOURCE_PDF_PAGES,
	validateSourcePdf,
} from "./pdf-policy";

describe("OMH PDF processing policy", () => {
	it("accepts genuine PDFs up to the published page bound and rejects the next page", async () => {
		await expect(validateSourcePdf(await pdfBytes(MAX_SOURCE_PDF_PAGES))).resolves.toBeUndefined();
		await expect(validateSourcePdf(await pdfBytes(MAX_SOURCE_PDF_PAGES + 1))).rejects.toMatchObject(
			{ code: "SOURCE_PDF_TOO_MANY_PAGES", status: 413 },
		);
	});

	it("checks the exact byte boundary before attempting to parse oversized bytes", async () => {
		const bytes = await pdfBytes(1);
		const padded = new Uint8Array(MAX_SOURCE_PDF_BYTES);
		padded.set(bytes);
		await expect(validateSourcePdf(padded)).resolves.toBeUndefined();
		await expect(validateSourcePdf(new Uint8Array(MAX_SOURCE_PDF_BYTES + 1))).rejects.toMatchObject(
			{ code: "SOURCE_PDF_TOO_LARGE", status: 413 },
		);
	});

	it("rejects PDF-looking text and encrypted page trees", async () => {
		await expect(
			validateSourcePdf(new TextEncoder().encode("%PDF-1.7\nnot an agreement\n%%EOF")),
		).rejects.toMatchObject({ code: "INVALID_SOURCE_PDF", status: 400 });
		const pdf = await PDFDocument.create();
		pdf.addPage();
		pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: "Standard" }));
		await expect(validateSourcePdf(await pdf.save())).rejects.toMatchObject({
			code: "INVALID_SOURCE_PDF",
			status: 400,
		});
	});

	it("limits the total signed fields at the renderer's measured admission bound", () => {
		expect(() => assertPdfFieldCount(MAX_DOCUMENT_FIELDS)).not.toThrow();
		expect(() => assertPdfFieldCount(MAX_DOCUMENT_FIELDS + 1)).toThrowError(
			expect.objectContaining({ code: "SOURCE_PDF_TOO_MANY_FIELDS", status: 413 }),
		);
	});
});

async function pdfBytes(pages: number): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	for (let page = 0; page < pages; page++) pdf.addPage([612, 792]);
	return pdf.save({ useObjectStreams: false });
}
