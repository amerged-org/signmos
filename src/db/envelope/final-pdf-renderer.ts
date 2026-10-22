import { type PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { assertPdfFieldCount, loadValidatedSourcePdf } from "./pdf-policy";
import type { SourceDocument } from "./schema";

export const FINAL_PDF_RENDERER_PRODUCER = "amerged-sign-final-pdf-renderer/4";

export class FinalPdfRenderError extends Error {
	constructor(
		public readonly code: "INVALID_SOURCE_PDF" | "FIELD_PAGE_MISSING",
		message: string,
	) {
		super(message);
		this.name = "FinalPdfRenderError";
	}
}

export type FinalPdfRows = {
	fields: Array<Record<string, unknown>>;
	values: Array<Record<string, unknown>>;
	events: Array<Record<string, unknown>>;
};

export async function renderFinalPdf(input: {
	envelopeId: string;
	sourceDocument: SourceDocument;
	rows: FinalPdfRows;
	certificateHash: string;
	sourceBytes: Uint8Array;
}): Promise<Uint8Array> {
	const rows = canonicalRows(input.rows);
	assertPdfFieldCount(rows.fields.length);
	const pdf = await loadValidatedSourcePdf(input.sourceBytes);
	pdf.setProducer(FINAL_PDF_RENDERER_PRODUCER);
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
	const signatureFont = await pdf.embedFont(StandardFonts.HelveticaOblique);
	drawFieldValues(pdf, rows, font, boldFont, signatureFont);
	drawAuditCertificate(
		pdf,
		input.envelopeId,
		input.sourceDocument,
		rows,
		input.certificateHash,
		font,
		boldFont,
	);
	return pdf.save({ useObjectStreams: false });
}

/**
 * pdf-lib saves the Info dictionary uncompressed (useObjectStreams: false) and writes the
 * Producer as a UTF-16BE hex string; a literal string is accepted as well.
 */
const CURRENT_PRODUCER_MARKERS = [
	Buffer.from(`/Producer (${FINAL_PDF_RENDERER_PRODUCER})`, "latin1"),
	Buffer.from(
		`/Producer <FEFF${[...FINAL_PDF_RENDERER_PRODUCER]
			.map((character) => character.charCodeAt(0).toString(16).padStart(4, "0"))
			.join("")
			.toUpperCase()}>`,
		"latin1",
	),
];

/**
 * Whether the stored final PDF was written by the current renderer. Every public download asks,
 * and a full pdf-lib parse only to read one string costs CPU in proportion to the object count
 * (about 60 ms at 2,000 objects, against a Worker's 50 ms): search the bytes natively instead.
 */
export function isCurrentFinalPdfArtifact(bytes: Uint8Array): Promise<boolean> {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return Promise.resolve(CURRENT_PRODUCER_MARKERS.some((marker) => buffer.includes(marker)));
}

export function buildCertificateMaterial(
	sourceDocument: SourceDocument,
	rows: FinalPdfRows,
): string {
	const stableRows = canonicalRows(rows);
	return [
		`source:${sourceDocument.sha256}`,
		"fields:",
		...buildFlattenedFieldLines(stableRows),
		"events:",
		...buildEventSummaryLines(stableRows.events),
	].join("\n");
}

function canonicalRows(rows: FinalPdfRows): FinalPdfRows {
	const ordered = (input: Array<Record<string, unknown>>, keys: string[]) =>
		[...input].sort((left, right) => {
			const leftKey = keys.map((key) => stringValue(left, key)).join("\u0000");
			const rightKey = keys.map((key) => stringValue(right, key)).join("\u0000");
			return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
		});
	return {
		fields: ordered(rows.fields, ["id", "page", "type", "x", "y"]),
		values: ordered(rows.values, ["fieldId", "id", "value"]),
		events: ordered(rows.events, ["createdAt", "id", "eventType", "message"]),
	};
}

function drawFieldValues(
	pdf: PDFDocument,
	rows: Pick<FinalPdfRows, "fields" | "values">,
	font: PDFFont,
	boldFont: PDFFont,
	signatureFont: PDFFont,
): void {
	const valueByField = new Map(
		rows.values.map((value) => [stringValue(value, "fieldId"), stringValue(value, "value")]),
	);
	for (const field of rows.fields) {
		const value = valueByField.get(stringValue(field, "id"))?.trim();
		if (!value) continue;
		const page = getSourcePage(pdf, numberValue(field, "page", 1));
		const box = fieldBoxOnPage(field, page);
		if (stringValue(field, "type") === "signature") {
			drawSignatureStamp(page, value, box, boldFont, signatureFont);
			continue;
		}
		page.drawRectangle({
			x: box.x,
			y: box.y,
			width: box.width,
			height: box.height,
			borderColor: rgb(0.05, 0.3, 0.75),
			borderWidth: 0.5,
		});
		const size = Math.min(12, box.height * 0.45);
		page.drawText(value, {
			x: box.x + 4,
			y: box.y + Math.max(4, (box.height - size) / 2),
			size,
			font,
			color: rgb(0.05, 0.05, 0.05),
			maxWidth: Math.max(12, box.width - 8),
		});
	}
}

function drawSignatureStamp(
	page: PDFPage,
	value: string,
	box: { x: number; y: number; width: number; height: number },
	boldFont: PDFFont,
	signatureFont: PDFFont,
): void {
	const accent = rgb(0.08, 0.31, 0.55);
	const ink = rgb(0.08, 0.14, 0.2);
	const muted = rgb(0.38, 0.45, 0.52);
	const insetX = Math.min(7, Math.max(4, box.width * 0.04));
	page.drawRectangle({
		x: box.x,
		y: box.y,
		width: box.width,
		height: box.height,
		color: rgb(0.97, 0.98, 0.99),
		borderColor: rgb(0.56, 0.66, 0.75),
		borderWidth: 0.75,
	});
	page.drawRectangle({
		x: box.x,
		y: box.y,
		width: Math.min(2.5, box.width * 0.02),
		height: box.height,
		color: accent,
	});

	const statusY = box.y + box.height - 9;
	page.drawCircle({
		x: box.x + insetX + 2.5,
		y: statusY + 2.5,
		size: 3.2,
		color: accent,
	});
	page.drawLine({
		start: { x: box.x + insetX + 0.8, y: statusY + 2.5 },
		end: { x: box.x + insetX + 2.1, y: statusY + 1.2 },
		color: rgb(1, 1, 1),
		thickness: 0.7,
	});
	page.drawLine({
		start: { x: box.x + insetX + 2.1, y: statusY + 1.2 },
		end: { x: box.x + insetX + 4.5, y: statusY + 4 },
		color: rgb(1, 1, 1),
		thickness: 0.7,
	});
	page.drawText("SIGNED", {
		x: box.x + insetX + 9,
		y: statusY,
		size: 6.5,
		font: boldFont,
		color: accent,
	});

	const caption = "sign.amerged.com";
	const captionSize = 5.5;
	const captionWidth = boldFont.widthOfTextAtSize(caption, captionSize);
	page.drawText(caption, {
		x: Math.max(box.x + insetX, box.x + box.width - insetX - captionWidth),
		y: box.y + 3,
		size: captionSize,
		font: boldFont,
		color: muted,
	});

	const signatureBox = {
		x: box.x + insetX,
		y: box.y + 8,
		width: Math.max(1, box.width - insetX * 2),
		height: Math.max(1, box.height - 18),
	};
	if (looksLikeSvgPath(value)) {
		drawSignaturePath(page, value, signatureBox);
		return;
	}
	const signatureSize = Math.min(16, signatureBox.height * 0.62);
	page.drawText(value, {
		x: signatureBox.x,
		y: signatureBox.y + Math.max(1, (signatureBox.height - signatureSize) / 2),
		size: signatureSize,
		font: signatureFont,
		color: ink,
		maxWidth: signatureBox.width,
	});
}

function drawSignaturePath(
	page: PDFPage,
	value: string,
	box: { x: number; y: number; width: number; height: number },
): void {
	try {
		const placement = signaturePathPlacement(value, box);
		page.drawSvgPath(value, {
			x: placement.x,
			y: placement.y,
			scale: placement.scale,
			borderColor: rgb(0.05, 0.05, 0.05),
			borderWidth: 1.2,
		});
	} catch {
		page.drawText("Signed", { x: box.x + 4, y: box.y + 8, size: 12 });
	}
}

function drawAuditCertificate(
	pdf: PDFDocument,
	envelopeId: string,
	sourceDocument: SourceDocument,
	rows: FinalPdfRows,
	certificateHash: string,
	font: PDFFont,
	boldFont: PDFFont,
): void {
	const eventSummary = buildEventSummaryLines(rows.events);
	const page = pdf.addPage([612, 792]);
	page.drawText("AUDIT CERTIFICATE", { x: 72, y: 740, size: 16, font: boldFont });
	drawLines(
		page,
		[
			`Envelope: ${envelopeId}`,
			`Source SHA-256: ${sourceDocument.sha256}`,
			`Certificate checksum: ${certificateHash}`,
			"",
			`Signed fields: ${rows.values.length}`,
			`Audit events: ${eventSummary.length}`,
			"Detailed field values and signing events are covered by the certificate checksum.",
		],
		72,
		708,
		font,
	);
}

function signaturePathPlacement(
	path: string,
	box: { x: number; y: number; width: number; height: number },
): { x: number; y: number; scale: number } {
	const inset = 4;
	const bounds = signaturePathBounds(path) ?? {
		minX: 0,
		minY: 0,
		maxX: 320,
		maxY: 128,
	};
	const pathWidth = Math.max(1, bounds.maxX - bounds.minX);
	const pathHeight = Math.max(1, bounds.maxY - bounds.minY);
	const innerWidth = Math.max(1, box.width - inset * 2);
	const innerHeight = Math.max(1, box.height - inset * 2);
	const scale = Math.min(innerWidth / pathWidth, innerHeight / pathHeight);
	const renderedWidth = pathWidth * scale;
	const renderedHeight = pathHeight * scale;
	const extraX = (innerWidth - renderedWidth) / 2;
	const extraY = (innerHeight - renderedHeight) / 2;

	return {
		x: box.x + inset + extraX - bounds.minX * scale,
		y: box.y + box.height - inset - extraY + bounds.minY * scale,
		scale,
	};
}

function signaturePathBounds(
	path: string,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
	const points = [...path.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)\s*,?\s*(-?\d+(?:\.\d+)?)/gi)]
		.map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))
		.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
	if (points.length === 0) return null;
	return {
		minX: Math.min(...points.map((point) => point.x)),
		minY: Math.min(...points.map((point) => point.y)),
		maxX: Math.max(...points.map((point) => point.x)),
		maxY: Math.max(...points.map((point) => point.y)),
	};
}

function getSourcePage(pdf: PDFDocument, pageNumber: number): PDFPage {
	if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.getPageCount()) {
		throw new FinalPdfRenderError(
			"FIELD_PAGE_MISSING",
			"A signing field refers to a page missing from the source PDF.",
		);
	}
	return pdf.getPage(pageNumber - 1);
}

function fieldBoxOnPage(
	field: Record<string, unknown>,
	page: PDFPage,
): { x: number; y: number; width: number; height: number } {
	const scaleX = page.getWidth() / 612;
	const scaleY = page.getHeight() / 792;
	const width = numberValue(field, "width", 120) * scaleX;
	const height = numberValue(field, "height", 32) * scaleY;
	return {
		x: numberValue(field, "x", 72) * scaleX,
		y: page.getHeight() - (numberValue(field, "y", 144) * scaleY + height),
		width,
		height,
	};
}

function drawLines(page: PDFPage, lines: string[], x: number, startY: number, font: PDFFont): void {
	let y = startY;
	for (const line of lines) {
		page.drawText(line || " ", {
			x,
			y,
			size: 10,
			font,
			color: rgb(0.05, 0.05, 0.05),
			maxWidth: 468,
			lineHeight: 14,
		});
		y -= line ? 16 : 10;
	}
}

function buildFlattenedFieldLines(rows: Pick<FinalPdfRows, "fields" | "values">): string[] {
	const valueByField = new Map(
		rows.values.map((value) => [stringValue(value, "fieldId"), stringValue(value, "value")]),
	);
	return rows.fields.map((field) =>
		[
			stringValue(field, "type"),
			`page=${stringValue(field, "page")}`,
			`x=${stringValue(field, "x")}`,
			`y=${stringValue(field, "y")}`,
			`width=${stringValue(field, "width")}`,
			`height=${stringValue(field, "height")}`,
			`value=${valueByField.get(stringValue(field, "id")) ?? ""}`,
		].join(" "),
	);
}

function buildEventSummaryLines(events: Array<Record<string, unknown>>): string[] {
	return events.map((event) =>
		[stringValue(event, "eventType"), stringValue(event, "message")].filter(Boolean).join(": "),
	);
}

function stringValue(row: Record<string, unknown> | undefined, key: string): string {
	const value = row?.[key];
	if (value instanceof Date) return value.toISOString();
	return value == null ? "" : String(value);
}

function numberValue(
	row: Record<string, unknown> | undefined,
	key: string,
	fallback: number,
): number {
	const value = Number(row?.[key]);
	return Number.isFinite(value) ? value : fallback;
}

function looksLikeSvgPath(value: string): boolean {
	return /^[MmLlHhVvCcSsQqTtAaZz0-9,.\s-]+$/.test(value.trim());
}
