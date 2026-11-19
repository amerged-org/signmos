/** A deterministic, uncompressed PDF so integration tests can inspect retained content. */
export function pdfFixtureText(text = "Source agreement", pageCount = 1): string {
	const printableText = text.replace(/[^\x20-\x7e]/g, " ").replace(/([\\()])/g, "\\$1");
	const pageIds = Array.from({ length: pageCount }, (_, index) => 4 + index * 2);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (const pageId of pageIds) {
		const content = `BT /F1 12 Tf 72 720 Td (${printableText}) Tj ET\n`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
			`<< /Length ${content.length} >>\nstream\n${content}endstream`,
		);
	}
	let pdf = "%PDF-1.7\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xrefOffset = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) {
		pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
}

export function pdfFixtureBytes(text?: string, pageCount?: number): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(pdfFixtureText(text, pageCount));
}
