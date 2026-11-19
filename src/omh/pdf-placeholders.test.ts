import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdfPlaceholders, PdfPlaceholderError } from "./pdf-placeholders";

describe("extractPdfPlaceholders", () => {
	it("locates proportional-font markers in surrounding text without masking neighbors", async () => {
		const pdf = await PDFDocument.create();
		const page = pdf.addPage([612, 792]);
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		const prefix = "Willi: ";
		const marker = "{{1.name}}";
		page.drawText(`${prefix}${marker} tail`, { x: 60, y: 500, size: 12, font });
		const [field] = await extractPdfPlaceholders(await pdf.save());
		expect(field).toMatchObject({ recipient: 1, name: "name", marker, page: 1 });
		const left = 60 + font.widthOfTextAtSize(prefix, 12);
		const right = left + font.widthOfTextAtSize(marker, 12);
		expect(field.x).toBe(Math.floor(left));
		expect(field.x + field.width).toBe(Math.ceil(right));
		expect(Number.isInteger(field.y)).toBe(true);
		expect(Number.isInteger(field.height)).toBe(true);
	});

	it("finds repeated markers and multiple recipients across pages", async () => {
		const pdf = await PDFDocument.create();
		pdf.addPage([612, 792]).drawText("{{1.name}}", { x: 40, y: 600, size: 14 });
		const page = pdf.addPage([612, 792]);
		page.drawText("{{2.sign}}", { x: 60, y: 500, size: 14 });
		page.drawText("{{1.name}}", { x: 60, y: 400, size: 14 });
		const fields = await extractPdfPlaceholders(await pdf.save());
		expect(fields.map(({ recipient, name, page }) => ({ recipient, name, page }))).toEqual([
			{ recipient: 1, name: "name", page: 1 },
			{ recipient: 2, name: "sign", page: 2 },
			{ recipient: 1, name: "name", page: 2 },
		]);
	});

	it("accepts adjacent marker pieces emitted in separate text runs", async () => {
		const pdf = await PDFDocument.create();
		const normal = await pdf.embedFont(StandardFonts.Helvetica);
		const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
		const page = pdf.addPage([612, 792]);
		const first = "{{1.";
		page.drawText(first, { x: 40, y: 600, size: 14, font: normal });
		page.drawText("name}}", {
			x: 40 + normal.widthOfTextAtSize(first, 14),
			y: 600,
			size: 14,
			font: bold,
		});
		const fields = await extractPdfPlaceholders(await pdf.save());
		expect(fields).toHaveLength(1);
		expect(fields[0]).toMatchObject({ recipient: 1, name: "name", page: 1 });
	});

	it("fails closed for malformed markers and unsupported rotated pages", async () => {
		const bad = await PDFDocument.create();
		bad.addPage([612, 792]).drawText("{{1.name}", { x: 40, y: 600 });
		await expect(extractPdfPlaceholders(await bad.save())).rejects.toBeInstanceOf(
			PdfPlaceholderError,
		);
		const rotated = await PDFDocument.create();
		const page = rotated.addPage([612, 792]);
		page.setRotation(degrees(90));
		page.drawText("{{1.name}}", { x: 40, y: 600 });
		await expect(extractPdfPlaceholders(await rotated.save())).rejects.toThrow(/rotation/);
	});
});
