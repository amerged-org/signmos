import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import {
	buildCertificateMaterial,
	isCurrentFinalPdfArtifact,
	renderFinalPdf,
} from "./final-pdf-renderer";
import type { SourceDocument } from "./schema";

describe("renderFinalPdf", () => {
	it("adds a continuation page for long values placed in small template markers", async () => {
		const bytes = await renderFinalPdf({
			envelopeId: "00000000-0000-4000-8000-000000000001",
			sourceDocument: await sourceDocumentFixture(),
			sourceBytes: await sourcePdfBytes(),
			certificateHash: "b".repeat(64),
			rows: {
				fields: [
					{
						id: "name",
						name: "name",
						type: "text",
						page: 1,
						x: 50,
						y: 100,
						width: 40,
						height: 10,
						isPlaceholder: true,
					},
					{
						id: "signature",
						name: "sign",
						type: "signature",
						page: 1,
						x: 50,
						y: 130,
						width: 40,
						height: 10,
						isPlaceholder: true,
					},
					{
						id: "drawn",
						name: "drawn",
						type: "signature",
						page: 1,
						x: 50,
						y: 160,
						width: 40,
						height: 10,
						isPlaceholder: true,
					},
				],
				values: [
					{ fieldId: "name", value: "A longer field value that must remain legible" },
					{ fieldId: "signature", value: "A very long typed signature" },
					{ fieldId: "drawn", value: "M 64 24 L 68 98 L 195 75" },
				],
				events: [],
			},
		});
		expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
		expect(extractSignatureTransform(bytes, "64 24 m").scale).toBeGreaterThan(0.5);
	});

	it("renders typed names that resemble SVG commands as text", async () => {
		for (const name of ["Sam", "Val"]) {
			const bytes = await renderFinalPdf({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				sourceDocument: await sourceDocumentFixture(),
				sourceBytes: await sourcePdfBytes(),
				certificateHash: "b".repeat(64),
				rows: {
					fields: [
						{ id: "signature", type: "signature", page: 1, x: 30, y: 40, width: 180, height: 52 },
					],
					values: [{ fieldId: "signature", value: name }],
					events: [],
				},
			});
			expect(extractVisibleText(bytes).join("\n")).toContain(name);
		}
	});

	it("covers each template marker including empty optional fields and renders Unicode values", async () => {
		const bytes = await renderFinalPdf({
			envelopeId: "00000000-0000-4000-8000-000000000001",
			sourceDocument: await sourceDocumentFixture(),
			sourceBytes: await sourcePdfBytes(),
			certificateHash: "b".repeat(64),
			rows: {
				fields: [
					{
						id: "name",
						type: "text",
						page: 1,
						x: 50,
						y: 100,
						width: 100,
						height: 20,
						isPlaceholder: true,
					},
					{
						id: "optional",
						type: "text",
						page: 1,
						x: 50,
						y: 140,
						width: 100,
						height: 20,
						isPlaceholder: true,
					},
					{
						id: "check",
						type: "checkbox",
						page: 1,
						x: 50,
						y: 180,
						width: 20,
						height: 20,
						isPlaceholder: true,
					},
				],
				values: [
					{ fieldId: "name", value: "Jörg Müller" },
					{ fieldId: "check", value: "true" },
				],
				events: [],
			},
		});
		const streams = extractInflatedStreams(bytes).join("\n");
		expect([...streams.matchAll(/1 1 1 rg/g)]).toHaveLength(3);
		expect(Buffer.from(bytes).toString("latin1")).toContain("NotoSans");
		// A checked box draws a frame and two crossing strokes.
		expect([...streams.matchAll(/\nS\n/g)].length).toBeGreaterThanOrEqual(3);
	});

	it("renders signature values in a restrained branded signing stamp", async () => {
		// Stamp design assumptions:
		// - Only signature fields receive the branded stamp; date fields remain compact values.
		// - The public artifact visibly identifies the field as signed and its signing origin.
		// - Typed and drawn signatures use the same stamp frame; this tracer test covers typed text.
		// - Exact colors and drawing operators are visual-QA concerns, not part of this text contract.
		const bytes = await renderFinalPdf({
			envelopeId: "00000000-0000-4000-8000-000000000001",
			sourceDocument: await sourceDocumentFixture(),
			sourceBytes: await sourcePdfBytes(),
			certificateHash: "b".repeat(64),
			rows: {
				fields: [
					{
						id: "signature-field",
						type: "signature",
						page: 1,
						x: 360,
						y: 650,
						width: 180,
						height: 52,
					},
				],
				values: [{ fieldId: "signature-field", value: "Ada Lovelace" }],
				events: [],
			},
		});

		const visibleText = extractVisibleText(bytes).join("\n");
		expect(visibleText).toContain("SIGNED");
		expect(visibleText).toContain("Ada Lovelace");
		expect(visibleText).toContain("sign.amerged.com");
	});

	it("keeps raw field values and audit events out of the visible audit certificate", async () => {
		// Regression assumptions:
		// - The certificate hash may still cover detailed field/event material.
		// - The visible certificate page should only show summary metadata, not raw paths/events.
		// - Text extraction here decodes pdf-lib's compressed content streams.
		const bytes = await renderFinalPdf({
			envelopeId: "00000000-0000-4000-8000-000000000001",
			sourceDocument: await sourceDocumentFixture(),
			sourceBytes: await sourcePdfBytes(),
			certificateHash: "b".repeat(64),
			rows: {
				fields: [
					{
						id: "signature-field",
						type: "signature",
						page: 1,
						x: 382,
						y: 659,
						width: 180,
						height: 48,
					},
					{ id: "date-field", type: "date", page: 1, x: 443, y: 729, width: 120, height: 32 },
				],
				values: [
					{ fieldId: "signature-field", value: "M 68 42 L 68 98 L 195 75" },
					{ fieldId: "date-field", value: "2026-05-25" },
				],
				events: [
					{ eventType: "field.value.completed", message: "Drawn signature" },
					{ eventType: "recipient.completed", message: "tom@auditmos.com" },
				],
			},
		});

		const visibleText = extractVisibleText(bytes).join("\n");
		expect(visibleText).toContain("AUDIT CERTIFICATE");
		expect(visibleText).toContain("Source SHA-256:");
		expect(visibleText).toContain("Certificate checksum:");
		expect(visibleText).not.toContain("FLATTENED FIELDS");
		expect(visibleText).not.toContain("SIGNING EVENT SUMMARY");
		expect(visibleText).not.toContain("signature page=1");
		expect(visibleText).not.toContain("field.value.completed");
		expect(visibleText).not.toContain("recipient.completed");
	});

	it("normalizes drawn signatures into the branded stamp bounds", async () => {
		const signaturePath = "M 64 24 L 68 98 L 195 75";
		const bytes = await renderFinalPdf({
			envelopeId: "00000000-0000-4000-8000-000000000001",
			sourceDocument: await sourceDocumentFixture(),
			sourceBytes: await sourcePdfBytes(),
			certificateHash: "b".repeat(64),
			rows: {
				fields: [
					{
						id: "signature-field",
						type: "signature",
						page: 1,
						x: 382,
						y: 659,
						width: 180,
						height: 48,
					},
				],
				values: [{ fieldId: "signature-field", value: signaturePath }],
				events: [],
			},
		});

		const visibleText = extractVisibleText(bytes).join("\n");
		expect(visibleText).toContain("SIGNED");
		expect(visibleText).toContain("sign.amerged.com");

		const signatureTransform = extractSignatureTransform(bytes, "64 24 m");
		expect(signatureTransform).toEqual({
			scale: expect.closeTo(0.2973, 4),
			x: expect.closeTo(433.5, 1),
			y: expect.closeTo(126.14, 1),
		});
	});

	it.each([
		new Uint8Array(),
		new TextEncoder().encode("%PDF-1.7\nnot a contract"),
	])("rejects unreadable source documents instead of manufacturing a blank contract", async (sourceBytes) => {
		await expect(
			renderFinalPdf({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				sourceDocument: await sourceDocumentFixture(),
				sourceBytes,
				certificateHash: "b".repeat(64),
				rows: { fields: [], values: [], events: [] },
			}),
		).rejects.toMatchObject({ code: "INVALID_SOURCE_PDF" });
	});

	it("rejects encrypted PDFs even when they contain parseable page objects", async () => {
		const pdf = await PDFDocument.create();
		pdf.addPage();
		pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: "Standard" }));
		const sourceBytes = await pdf.save({ useObjectStreams: false });
		await expect(
			renderFinalPdf({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				sourceDocument: await sourceDocumentFixture(),
				sourceBytes,
				certificateHash: "b".repeat(64),
				rows: { fields: [], values: [], events: [] },
			}),
		).rejects.toMatchObject({ code: "INVALID_SOURCE_PDF" });
		await expect(isCurrentFinalPdfArtifact(sourceBytes)).resolves.toBe(false);
	});

	it("rejects fields on nonexistent pages instead of appending blank source pages", async () => {
		await expect(
			renderFinalPdf({
				envelopeId: "00000000-0000-4000-8000-000000000001",
				sourceDocument: await sourceDocumentFixture(),
				sourceBytes: await sourcePdfBytes(),
				certificateHash: "b".repeat(64),
				rows: {
					fields: [{ id: "signature", type: "signature", page: 50000 }],
					values: [{ fieldId: "signature", value: "Ada" }],
					events: [],
				},
			}),
		).rejects.toMatchObject({ code: "FIELD_PAGE_MISSING" });
	});

	it("renders identical bytes on retries while preserving original contract pages", async () => {
		const sourceBytes = await sourcePdfBytes();
		const input = {
			envelopeId: "00000000-0000-4000-8000-000000000001",
			sourceDocument: await sourceDocumentFixture(),
			sourceBytes,
			certificateHash: "b".repeat(64),
			rows: { fields: [], values: [], events: [] },
		};
		const first = await renderFinalPdf(input);
		const second = await renderFinalPdf(input);
		expect(first).toEqual(second);
		const pdf = await PDFDocument.load(first);
		expect(pdf.getPageCount()).toBe(2);
		await expect(isCurrentFinalPdfArtifact(first)).resolves.toBe(true);
	});

	it("keeps certificate and artifact versions stable when PostgreSQL returns rows in a different order", async () => {
		const sourceDocument = await sourceDocumentFixture();
		const rows = {
			fields: [
				{ id: "b", type: "date", page: 1, x: 72, y: 660, width: 100, height: 32 },
				{ id: "a", type: "signature", page: 1, x: 72, y: 600, width: 180, height: 52 },
			],
			values: [
				{ fieldId: "b", value: "2026-10-21" },
				{ fieldId: "a", value: "Ada Lovelace" },
			],
			events: [
				{ id: "b", eventType: "recipient.completed" },
				{ id: "a", eventType: "source.uploaded" },
			],
		};
		const reversed = {
			fields: [...rows.fields].reverse(),
			values: [...rows.values].reverse(),
			events: [...rows.events].reverse(),
		};
		expect(buildCertificateMaterial(sourceDocument, rows)).toBe(
			buildCertificateMaterial(sourceDocument, reversed),
		);
		const input = {
			envelopeId: sourceDocument.envelopeId,
			sourceDocument,
			sourceBytes: await sourcePdfBytes(),
			certificateHash: "b".repeat(64),
		};
		expect(await renderFinalPdf({ ...input, rows })).toEqual(
			await renderFinalPdf({ ...input, rows: reversed }),
		);
	});
});

async function sourceDocumentFixture(): Promise<SourceDocument> {
	const bytes = await sourcePdfBytes();
	return {
		id: "10000000-0000-4000-8000-000000000001",
		envelopeId: "00000000-0000-4000-8000-000000000001",
		r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source.pdf",
		version: 1,
		sha256: "a".repeat(64),
		byteSize: bytes.byteLength,
		contentType: "application/pdf",
		originalFilename: "contract.pdf",
		uploadedBy: "tom@auditmos.com",
		uploadedAt: new Date("2026-05-25T12:00:00.000Z"),
	};
}

async function sourcePdfBytes(): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	pdf.addPage([612, 792]);
	return pdf.save({ useObjectStreams: false });
}

function extractVisibleText(bytes: Uint8Array): string[] {
	return extractInflatedStreams(bytes).flatMap((stream) =>
		[...stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((match) => hexToText(match[1] ?? "")),
	);
}

function extractSignatureTransform(
	bytes: Uint8Array,
	firstPathCommand: string,
): { x: number; y: number; scale: number } {
	const content = extractInflatedStreams(bytes).find((stream) => stream.includes(firstPathCommand));
	if (!content) throw new Error("Signature path content stream not found");
	const beforePath = content.slice(0, content.indexOf(firstPathCommand));
	const translate = [...beforePath.matchAll(/\b1 0 0 1 (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) cm/g)]
		.map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))
		.filter((matrix) => matrix.x !== 0 || matrix.y !== 0)
		.at(-1);
	const scale = [...beforePath.matchAll(/\b(-?\d+(?:\.\d+)?) 0 0 (-?\d+(?:\.\d+)?) 0 0 cm/g)]
		.map((match) => Number(match[1]))
		.at(-1);
	if (!translate || scale == null) throw new Error("Signature transform was not found");
	return { ...translate, scale };
}

function extractInflatedStreams(bytes: Uint8Array): string[] {
	const serialized = Buffer.from(bytes).toString("latin1");
	return [...serialized.matchAll(/stream\n([\s\S]*?)\nendstream/g)].flatMap((match) => {
		try {
			return [inflateSync(Buffer.from(match[1] ?? "", "latin1")).toString("latin1")];
		} catch {
			return [];
		}
	});
}

function hexToText(hex: string): string {
	return Buffer.from(hex, "hex").toString("utf8");
}
