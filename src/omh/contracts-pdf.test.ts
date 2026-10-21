import { PDFDocument } from "pdf-lib";
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

describe("contract PDF preparation", () => {
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
