import { PDFDocument } from "pdf-lib";
import { getDocument, OPS, VerbosityLevel } from "pdfjs-dist";
// pdfjs-dist does not publish a declaration for its worker module.
// @ts-expect-error WorkerMessageHandler is exported by the PDF.js worker bundle.
import * as pdfWorker from "pdfjs-dist/build/pdf.worker.mjs";

export interface PdfPlaceholder {
	recipient: number;
	name: string;
	marker: string;
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export class PdfPlaceholderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PdfPlaceholderError";
	}
}

type Part = {
	text: string;
	x: number;
	baseline: number;
	width: number;
	top: number;
	bottom: number;
	advances?: number[];
};

type PdfJsPage = Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>["promise"]>["getPage"]>>;
type PdfLibPage = ReturnType<PDFDocument["getPage"]>;

/** Extract marker positions in the same top-left 612 x 792 space used by the signing engine. */
export async function extractPdfPlaceholders(bytes: Uint8Array): Promise<PdfPlaceholder[]> {
	// Workers cannot spawn a nested browser Worker. PDF.js supports its in-process worker explicitly.
	Object.assign(globalThis, { pdfjsWorker: pdfWorker });
	const task = getDocument({ data: bytes.slice(), verbosity: VerbosityLevel.ERRORS });
	try {
		const [document, geometry] = await Promise.all([
			task.promise,
			PDFDocument.load(bytes, { updateMetadata: false }),
		]);
		const result: PdfPlaceholder[] = [];
		for (let index = 0; index < document.numPages; index++) {
			const page = await document.getPage(index + 1);
			const media = assertSupportedPage(page, geometry.getPage(index), index + 1);
			const parts = await getPageParts(page, index + 1);
			result.push(...findMarkers(parts, index + 1, media.width, media.height));
			page.cleanup();
		}
		return result;
	} catch (error) {
		if (error instanceof PdfPlaceholderError) throw error;
		throw new PdfPlaceholderError(
			"Could not extract text from the PDF; upload a readable, unencrypted PDF",
		);
	} finally {
		await task.destroy();
	}
}

function assertSupportedPage(page: PdfJsPage, pdfPage: PdfLibPage, pageNumber: number) {
	const media = pdfPage.getMediaBox();
	const crop = pdfPage.getCropBox();
	if (
		page.rotate !== 0 ||
		media.x !== 0 ||
		media.y !== 0 ||
		crop.x !== media.x ||
		crop.y !== media.y ||
		crop.width !== media.width ||
		crop.height !== media.height ||
		page.userUnit !== 1
	) {
		throw new PdfPlaceholderError(
			`Page ${pageNumber} uses rotation, crop or a coordinate system that cannot be placed safely`,
		);
	}
	return media;
}

async function getPageParts(page: PdfJsPage, pageNumber: number): Promise<Part[]> {
	const content = await page.getTextContent();
	const markerText = content.items.some((item) => "str" in item && /[{}]/.test(item.str));
	const advances = markerText ? await glyphAdvances(page) : new Map<string, number[] | null>();
	const parts: Part[] = [];
	for (const item of content.items) {
		if (!("str" in item) || !item.str) continue;
		const [a, b, c, d, x, baseline] = item.transform;
		if (
			a === undefined ||
			b === undefined ||
			c === undefined ||
			d === undefined ||
			x === undefined ||
			baseline === undefined
		) {
			throw new PdfPlaceholderError(`Page ${pageNumber} contains text without usable coordinates`);
		}
		if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d <= 0 || item.dir !== "ltr") {
			if (/[{}]/.test(item.str))
				throw new PdfPlaceholderError(
					`Page ${pageNumber} contains a rotated or mirrored placeholder`,
				);
			continue;
		}
		const style = content.styles[item.fontName];
		const textHeight = Math.abs(item.height || d);
		const characterWidths = advances.get(item.str);
		// Extra character/word spacing changes the ratio; do not guess in that case.
		const sum = characterWidths?.reduce((total, value) => total + value, 0);
		const accurate =
			sum && Math.abs((sum * a) / 1000 - item.width) < 0.1 ? characterWidths : undefined;
		parts.push({
			text: item.str,
			x,
			baseline,
			width: item.width,
			top: baseline + textHeight * (style?.ascent ?? 0.8),
			bottom: baseline + textHeight * (style?.descent ?? -0.2),
			advances: accurate || undefined,
		});
		if (item.hasEOL) parts.push({ text: "\n", x: 0, baseline: 0, width: 0, top: 0, bottom: 0 });
	}
	return parts;
}

/** Recover glyph advances only for unambiguous, unkerned text-show operations. */
async function glyphAdvances(page: PdfJsPage): Promise<Map<string, number[] | null>> {
	const result = new Map<string, number[] | null>();
	const ops = await page.getOperatorList();
	for (let index = 0; index < ops.fnArray.length; index++) {
		if (ops.fnArray[index] !== OPS.showText) continue;
		const args: unknown = ops.argsArray[index];
		if (!Array.isArray(args) || !Array.isArray(args[0])) continue;
		const glyphs: unknown[] = args[0];
		const chars: string[] = [];
		const widths: number[] = [];
		for (const value of glyphs) {
			if (!value || typeof value !== "object" || !("unicode" in value) || !("width" in value))
				break;
			if (
				typeof value.unicode !== "string" ||
				value.unicode.length !== 1 ||
				typeof value.width !== "number" ||
				!Number.isFinite(value.width)
			)
				break;
			chars.push(value.unicode);
			widths.push(value.width);
		}
		if (chars.length !== glyphs.length) continue;
		const text = chars.join("");
		if (!/[{}]/.test(text)) continue;
		const prior = result.get(text);
		if (prior === undefined) result.set(text, widths);
		else if (prior === null || prior.some((value, i) => value !== widths[i]))
			result.set(text, null);
	}
	return result;
}

function findMarkers(parts: Part[], page: number, width: number, height: number): PdfPlaceholder[] {
	const result: PdfPlaceholder[] = [];
	let group: Part[] = [];
	const flush = () => {
		if (group.length) result.push(...findGroupMarkers(group, page, width, height));
		group = [];
	};
	for (const part of parts) {
		const previous = group.at(-1);
		if (part.text === "\n") {
			flush();
			continue;
		}
		if (previous) {
			const gap = part.x - (previous.x + previous.width);
			const tolerance = Math.max(1, (previous.top - previous.bottom) * 0.2);
			if (
				Math.abs(part.baseline - previous.baseline) > tolerance ||
				gap < -tolerance ||
				gap > tolerance
			)
				flush();
		}
		group.push(part);
	}
	flush();
	return result;
}

function findGroupMarkers(
	group: Part[],
	page: number,
	width: number,
	height: number,
): PdfPlaceholder[] {
	const text = group.map((part) => part.text).join("");
	const expression = /\{\{([1-9][0-9]*)\.([^{}\r\n]+?)\}\}/g;
	const matches = [...text.matchAll(expression)];
	let residue = text;
	const result: PdfPlaceholder[] = [];
	for (const match of matches) {
		residue = residue.replace(match[0], "");
		const name = match[2];
		const recipient = Number(match[1]);
		if (!name || name.trim() !== name || !Number.isSafeInteger(recipient)) {
			throw new PdfPlaceholderError(`Invalid placeholder ${match[0]} on page ${page}`);
		}
		const box = markerBox(group, match.index, match.index + match[0].length, page);
		if (
			!(
				box.left >= 0 &&
				box.right <= width &&
				box.bottom >= 0 &&
				box.top <= height &&
				box.right > box.left &&
				box.top > box.bottom
			)
		) {
			throw new PdfPlaceholderError(`Placeholder ${match[0]} on page ${page} is outside the page`);
		}
		// The persisted coordinates are integers. Round outward so the full marker is covered.
		const x = Math.floor((box.left / width) * 612);
		const y = Math.floor(((height - box.top) / height) * 792);
		const right = Math.ceil((box.right / width) * 612);
		const bottom = Math.ceil(((height - box.bottom) / height) * 792);
		result.push({
			recipient,
			name,
			marker: match[0],
			page,
			x,
			y,
			width: right - x,
			height: bottom - y,
		});
	}
	if (residue.includes("{{") || residue.includes("}}")) {
		throw new PdfPlaceholderError(`Malformed or split placeholder on page ${page}`);
	}
	return result;
}

function markerBox(group: Part[], markerStart: number, markerEnd: number, page: number) {
	let offset = 0;
	const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
	for (const part of group) {
		const start = Math.max(markerStart, offset);
		const end = Math.min(markerEnd, offset + part.text.length);
		if (start < end) {
			const localStart = start - offset;
			const localEnd = end - offset;
			if ((localStart !== 0 || localEnd !== part.text.length) && !part.advances) {
				throw new PdfPlaceholderError(
					`A placeholder on page ${page} shares text with content whose position cannot be determined safely`,
				);
			}
			const advances = part.advances;
			const total = advances?.reduce((sum, value) => sum + value, 0) ?? 0;
			const left = advances
				? (advances.slice(0, localStart).reduce((a, b) => a + b, 0) / total) * part.width
				: 0;
			const right = advances
				? (advances.slice(0, localEnd).reduce((a, b) => a + b, 0) / total) * part.width
				: part.width;
			boxes.push({
				left: part.x + left,
				right: part.x + right,
				top: part.top,
				bottom: part.bottom,
			});
		}
		offset += part.text.length;
	}
	return {
		left: Math.min(...boxes.map((box) => box.left)),
		right: Math.max(...boxes.map((box) => box.right)),
		top: Math.max(...boxes.map((box) => box.top)),
		bottom: Math.min(...boxes.map((box) => box.bottom)),
	};
}
