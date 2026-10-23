import { randomBytes } from "node:crypto";
import { PDFDocument, PDFName } from "pdf-lib";
import { prepareContractPdf } from "@/omh/contracts-pdf";
import type { CreateContractRequest } from "@/omh/contracts-schema";

// A hosted Worker has 50 ms of CPU per request. The first hosted build decoded the base64 body
// with a per-byte callback; for a body at the size limit that alone took 90-125 ms of CPU in
// Node, against 14-20 ms for the whole preparation (native decode plus PDF parse), measured on a
// laptop on 2026-10-22. The test compares both on the same machine and the same payload, so it
// needs no absolute figure. It catches a return to the per-byte decode, not a drift of a few
// milliseconds, and it says nothing about how Cloudflare accounts CPU.
async function largeRequest(): Promise<CreateContractRequest> {
	const pdf = await PDFDocument.create();
	pdf.addPage([612, 792]);
	// Random bytes do not compress: the saved PDF and its base64 text stay at the size limit.
	pdf.catalog.set(
		PDFName.of("Payload"),
		pdf.context.register(pdf.context.stream(randomBytes(1_900_000))),
	);
	const bytes = await pdf.save({ useObjectStreams: false });
	return {
		title: "Large request",
		recipient: { name: "Ada Lovelace", email: "ada@example.com" },
		pdf: { filename: "large.pdf", base64: Buffer.from(bytes).toString("base64") },
		fields: [{ type: "signature", page: 1, x: 72, y: 320, width: 280, height: 70 }],
	};
}

async function cpuMilliseconds(run: () => unknown): Promise<number> {
	const before = process.cpuUsage();
	await run();
	const used = process.cpuUsage(before);
	return (used.user + used.system) / 1000;
}

async function bestOf(runs: number, run: () => unknown): Promise<number> {
	let best = Number.POSITIVE_INFINITY;
	for (let index = 0; index < runs; index += 1) best = Math.min(best, await cpuMilliseconds(run));
	return best;
}

describe("contract request CPU budget", () => {
	it("prepares a request at the size limit in under half the CPU of the per-byte decode alone", async () => {
		const request = await largeRequest();
		expect(request.pdf.base64.length).toBeGreaterThan(2_400_000);
		const perByteDecode = await bestOf(3, () =>
			Uint8Array.from(atob(request.pdf.base64), (character) => character.charCodeAt(0)),
		);
		const preparation = await bestOf(3, () => prepareContractPdf(request));
		console.info(
			`per-byte decode ${perByteDecode.toFixed(1)} ms CPU, preparation ${preparation.toFixed(1)} ms CPU`,
		);
		expect(preparation).toBeLessThan(perByteDecode / 2);
	});
});
