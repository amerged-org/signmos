import { isPdf } from "@/hono/api/envelope-route-helpers";
import {
	encodeContractPdf,
	type HtmlContractRequest,
	type MultipartContractRequest,
} from "./contracts-multipart";
import { ContractError, MAX_CONTRACT_PDF_BYTES } from "./contracts-schema";

export interface ContractBrowserEnv {
	OHMYHOST_BROWSER_BASE_URL?: string;
	OHMYHOST_BROWSER_KEY?: string;
}

export async function renderHtmlContract(
	{ html, ...definition }: HtmlContractRequest,
	env?: ContractBrowserEnv,
): Promise<MultipartContractRequest> {
	if (!env?.OHMYHOST_BROWSER_BASE_URL || !env.OHMYHOST_BROWSER_KEY)
		throw new ContractError("HTML_RENDERING_UNAVAILABLE", "HTML rendering is not configured", 503);
	let response: Response;
	try {
		response = await fetch(
			new Request(`${env.OHMYHOST_BROWSER_BASE_URL.replace(/\/$/, "")}/pdf`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(31_000),
				headers: {
					authorization: `Bearer ${env.OHMYHOST_BROWSER_KEY}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ html: html.content }),
			}),
		);
	} catch {
		throw new ContractError("HTML_RENDERING_UNAVAILABLE", "HTML rendering did not respond", 503);
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw rendererError(response.status);
	}
	const bytes = await readRenderedPdf(response);
	return {
		...definition,
		pdf: { filename: html.filename.replace(/\.html?$/i, ".pdf"), base64: encodeContractPdf(bytes) },
	};
}

function rendererError(status: number): ContractError {
	if ([400, 415, 422].includes(status))
		return new ContractError("INVALID_SOURCE_HTML", "The renderer rejected the supplied HTML");
	if (status === 413)
		return new ContractError(
			"HTML_RENDER_LIMIT",
			"The HTML exceeded a renderer size or page limit",
			413,
		);
	if (status === 402)
		return new ContractError(
			"HTML_RENDER_CREDITS_UNAVAILABLE",
			"HTML rendering requires available billing coverage",
			503,
		);
	if (status === 429)
		return new ContractError(
			"HTML_RENDER_RATE_LIMITED",
			"The HTML renderer is temporarily rate limited",
			503,
		);
	return new ContractError(
		"HTML_RENDERING_UNAVAILABLE",
		"The HTML renderer is temporarily unavailable",
		503,
	);
}

async function readRenderedPdf(response: Response): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) throw invalidOutput();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_CONTRACT_PDF_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new ContractError(
					"SOURCE_PDF_TOO_LARGE",
					"The rendered PDF must be at most 2 MiB",
					413,
				);
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof ContractError) throw error;
		throw invalidOutput();
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (!isPdf(bytes)) throw invalidOutput();
	return bytes;
}

function invalidOutput() {
	return new ContractError(
		"HTML_RENDER_INVALID_PDF",
		"The renderer did not return a readable PDF",
		502,
	);
}
