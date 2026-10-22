import { PDFDocument, PDFName } from "pdf-lib";
import { prepareContractPdf } from "./contracts-pdf";
import { type CreateContractRequest, CreateContractSchema } from "./contracts-schema";

async function request(
	fields?: CreateContractRequest["fields"],
	pages = 1,
): Promise<CreateContractRequest> {
	const pdf = await PDFDocument.create();
	for (let page = 0; page < pages; page++) pdf.addPage([420, 595]);
	return {
		title: "Consulting agreement",
		recipient: { name: "Ada", email: "ada@example.com" },
		pdf: { filename: "agreement.pdf", base64: Buffer.from(await pdf.save()).toString("base64") },
		fields,
	};
}

/** A valid PDF of roughly `size` bytes whose stream carries every byte value, uncompressed. */
async function binaryPdf(size: number): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	pdf.addPage([420, 595]);
	const payload = new Uint8Array(size);
	for (let index = 0; index < size; index += 1) payload[index] = (index * 31 + 7) & 0xff;
	pdf.catalog.set(PDFName.of("SignPayload"), pdf.context.register(pdf.context.stream(payload)));
	return pdf.save({ useObjectStreams: false });
}

describe("contract PDF preparation", () => {
	it("decodes a near-maximum binary PDF byte for byte into its own exactly sized buffer", async () => {
		const original = await binaryPdf(2_000_000);
		expect(original.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
		const input = await request([
			{ type: "signature", page: 1, x: 72, y: 320, width: 280, height: 70 },
		]);
		input.pdf.base64 = Buffer.from(original).toString("base64");
		const result = await prepareContractPdf(input);
		expect(Buffer.from(result.bytes).equals(Buffer.from(original))).toBe(true);
		expect(result.bytes.byteOffset).toBe(0);
		expect(result.bytes.buffer.byteLength).toBe(original.byteLength);
	});
	it("rejects an oversized upload from its base64 length, before decoding it", async () => {
		const input = await request();
		input.pdf.base64 = "A".repeat(2_796_208);
		await expect(prepareContractPdf(input)).rejects.toMatchObject({
			code: "SOURCE_PDF_TOO_LARGE",
			status: 413,
		});
	});

	it("retains original page size and adds a dedicated signature page by default", async () => {
		const result = await prepareContractPdf(await request());
		const pdf = await PDFDocument.load(result.bytes);
		expect(pdf.getPageCount()).toBe(2);
		expect(pdf.getPage(0).getSize()).toEqual({ width: 420, height: 595 });
		expect(result.fields).toEqual([
			{ type: "signature", page: 2, x: 72, y: 320, width: 280, height: 70 },
			{ type: "date", page: 2, x: 72, y: 440, width: 180, height: 35 },
		]);
	});
	it("uses explicit fields on the original PDF without changing source bytes", async () => {
		const input = await request([
			{ type: "signature", page: 1, x: 72, y: 320, width: 280, height: 70 },
		]);
		const result = await prepareContractPdf(input);
		expect(Buffer.from(result.bytes).toString("base64")).toBe(input.pdf.base64);
		expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(1);
	});
	it("keeps default and explicit placement inside the shared 10-page policy", async () => {
		const ninePages = await prepareContractPdf(await request(undefined, 9));
		expect((await PDFDocument.load(ninePages.bytes)).getPageCount()).toBe(10);
		await expect(prepareContractPdf(await request(undefined, 10))).rejects.toMatchObject({
			code: "SOURCE_PDF_TOO_MANY_PAGES",
			status: 413,
		});
		const fields: CreateContractRequest["fields"] = [
			{ type: "signature", page: 10, x: 72, y: 320, width: 280, height: 70 },
		];
		const tenPages = await prepareContractPdf(await request(fields, 10));
		expect((await PDFDocument.load(tenPages.bytes)).getPageCount()).toBe(10);
		await expect(prepareContractPdf(await request(fields, 11))).rejects.toMatchObject({
			code: "SOURCE_PDF_TOO_MANY_PAGES",
			status: 413,
		});
	});

	it("rejects unreadable PDFs instead of substituting a blank page", async () => {
		const input = await request();
		input.pdf.base64 = Buffer.from("%PDF-1.7\ncorrupt").toString("base64");
		await expect(prepareContractPdf(input)).rejects.toMatchObject({ code: "INVALID_SOURCE_PDF" });
	});
	it("rejects nonexisting pages", async () => {
		const input = await request([
			{ type: "signature", page: 2, x: 72, y: 320, width: 280, height: 70 },
		]);
		await expect(prepareContractPdf(input)).rejects.toMatchObject({ code: "INVALID_FIELDS" });
	});
	it("rejects invalid base64 and non-PDF data", async () => {
		for (const base64 of [
			"data:application/pdf;base64,AA==",
			"not-base64",
			Buffer.from("not a PDF").toString("base64"),
		]) {
			const input = await request();
			input.pdf.base64 = base64;
			await expect(prepareContractPdf(input)).rejects.toMatchObject({ code: "INVALID_SOURCE_PDF" });
		}
	});
	it("requires exactly one signature and all custom fields inside the coordinate space", async () => {
		const input = await request();
		expect(
			CreateContractSchema.safeParse({
				...input,
				fields: [{ type: "date", page: 1, x: 72, y: 320, width: 180, height: 32 }],
			}).success,
		).toBe(false);
		expect(
			CreateContractSchema.safeParse({
				...input,
				fields: [{ type: "signature", page: 1, x: 600, y: 320, width: 180, height: 32 }],
			}).success,
		).toBe(false);
	});
});
