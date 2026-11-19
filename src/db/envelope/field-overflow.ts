import { type PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";

export interface OverflowFieldValue {
	page: number;
	name: string;
	value: string;
	kind?: "signature";
}

/** Text below six points is unlikely to be legible, so retain it on continuation pages. */
export function fieldValueNeedsContinuation(
	value: string,
	box: { width: number; height: number },
	font: PDFFont,
): boolean {
	const unitWidth = font.widthOfTextAtSize(value.replace(/[\r\n]+/g, " "), 1);
	return box.height * 0.8 < 6 || box.width / Math.max(1, unitWidth) < 6;
}

/** Add as many pages as needed without clipping or truncating any field value. */
export function appendFieldContinuationPages(
	pdf: PDFDocument,
	fields: OverflowFieldValue[],
	font: PDFFont,
	drawSignature: (
		page: PDFPage,
		value: string,
		box: { x: number; y: number; width: number; height: number },
	) => void,
): void {
	if (fields.length === 0) return;
	let page = pdf.addPage([612, 792]);
	let y = 740;
	const drawLine = (line: string, size = 10) => {
		if (y < 55) {
			page = pdf.addPage([612, 792]);
			y = 740;
		}
		page.drawText(line || " ", { x: 72, y, size, font, color: rgb(0.05, 0.05, 0.05) });
		y -= size + 5;
	};
	drawLine("FIELD VALUES CONTINUED", 14);
	drawLine("References on the original pages point to the full values below.");
	y -= 8;
	for (const [index, field] of fields.entries()) {
		for (const line of wrap(`[${index + 1}] ${field.name} (page ${field.page})`, font, 468)) {
			drawLine(line);
		}
		if (field.kind === "signature") {
			if (y < 125) {
				page = pdf.addPage([612, 792]);
				y = 740;
			}
			drawSignature(page, field.value, { x: 72, y: y - 60, width: 468, height: 60 });
			y -= 75;
		} else {
			for (const line of wrap(field.value, font, 468)) drawLine(line);
		}
		y -= 10;
	}
}

function wrap(value: string, font: PDFFont, maxWidth: number): string[] {
	const output: string[] = [];
	for (const paragraph of value.replace(/\r\n?/g, "\n").split("\n")) {
		let line = "";
		for (const character of paragraph) {
			const next = line + character;
			if (line && font.widthOfTextAtSize(next, 10) > maxWidth) {
				output.push(line);
				line = character;
			} else line = next;
		}
		output.push(line);
	}
	return output;
}
