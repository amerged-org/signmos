import { inflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { appendFieldContinuationPages, fieldValueNeedsContinuation } from "./field-overflow";

describe("field value continuations", () => {
	it("keeps the full value across as many pages as needed and labels its reference", async () => {
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		const value = "abcdefghijklmnop".repeat(1000);
		expect(fieldValueNeedsContinuation(value, { width: 50, height: 10 }, font)).toBe(true);
		expect(fieldValueNeedsContinuation("Ada", { width: 100, height: 20 }, font)).toBe(false);
		appendFieldContinuationPages(pdf, [{ page: 3, name: "company", value }], font, () => {});
		expect(pdf.getPageCount()).toBeGreaterThan(1);
		const bytes = await pdf.save({ useObjectStreams: false });
		const serialized = Buffer.from(bytes).toString("latin1");
		const text = [...serialized.matchAll(/stream\n([\s\S]*?)\nendstream/g)]
			.flatMap((match) => {
				try {
					return [inflateSync(Buffer.from(match[1] ?? "", "latin1")).toString("latin1")];
				} catch {
					return [];
				}
			})
			.flatMap((stream) => [...stream.matchAll(/<([0-9A-F]+)>\s*Tj/g)])
			.map((match) => Buffer.from(match[1] ?? "", "hex").toString("latin1"))
			.join("");
		expect(text).toContain("[1] company (page 3)");
		expect(text).toContain(value);
	});
});
