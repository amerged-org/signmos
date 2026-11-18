import { z } from "zod";
import { MAX_DOCUMENT_FIELDS } from "@/db/envelope/pdf-policy-limits";
import { ContractError, MAX_CONTRACT_PDF_BYTES, readContractRequestBody } from "./contracts-schema";

const MAX_CONTRACT_HTML_BYTES = 1024 * 1024;

const RecipientSchema = z
	.object({
		index: z.number().int().positive(),
		name: z.string().trim().min(1).max(120),
		email: z.email().trim().toLowerCase().max(254),
	})
	.strict();
const FieldSchema = z
	.object({
		recipient: z.number().int().positive(),
		name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
		type: z.enum(["text", "date", "checkbox", "signature"]),
		label: z.string().trim().min(1).max(120),
		required: z.boolean(),
	})
	.strict();
export const MultipartContractSchema = z
	.object({
		title: z.string().trim().min(1).max(160),
		recipients: z.array(RecipientSchema).min(1).max(3),
		fields: z.array(FieldSchema).min(1).max(MAX_DOCUMENT_FIELDS),
	})
	.strict()
	.superRefine((value, ctx) => {
		const indices = new Set<number>();
		const emails = new Set<string>();
		for (const recipient of value.recipients) {
			if (indices.has(recipient.index) || emails.has(recipient.email))
				ctx.addIssue({
					code: "custom",
					message: "Recipient indices and emails must be unique",
					path: ["recipients"],
				});
			indices.add(recipient.index);
			emails.add(recipient.email);
		}
		const fields = new Set<string>();
		for (const field of value.fields) {
			const key = `${field.recipient}.${field.name}`;
			if (!indices.has(field.recipient) || fields.has(key))
				ctx.addIssue({
					code: "custom",
					message: "Field definitions must be unique and reference an existing recipient",
					path: ["fields"],
				});
			fields.add(key);
		}
		for (const recipient of value.recipients) {
			if (!value.fields.some((field) => field.recipient === recipient.index))
				ctx.addIssue({
					code: "custom",
					message: "Each recipient needs a field",
					path: ["recipients"],
				});
		}
	});
export type MultipartContractRequest = z.infer<typeof MultipartContractSchema> & {
	kind: "placeholder";
	pdf: { filename: string; base64: string };
};
export type HtmlContractRequest = z.infer<typeof MultipartContractSchema> & {
	kind: "placeholder";
	html: { filename: string; content: string };
};

export async function readMultipartContract(
	request: Request,
	allowHtml: boolean,
): Promise<MultipartContractRequest | HtmlContractRequest> {
	const data = await readContractRequestBody(request);
	let form: FormData;
	try {
		form = await new Request(request.url, {
			method: "POST",
			headers: { "content-type": request.headers.get("content-type") ?? "" },
			body: data,
		}).formData();
	} catch {
		throw new ContractError("INVALID_CONTRACT", "Malformed multipart form");
	}
	const sourcePart = allowHtml && form.has("html") ? "html" : "pdf";
	if (
		form.getAll(sourcePart).length !== 1 ||
		form.getAll("definition").length !== 1 ||
		[...form.keys()].some((key) => key !== sourcePart && key !== "definition")
	)
		throw new ContractError(
			"INVALID_CONTRACT",
			"Provide exactly one source file and one definition part",
		);
	const file = form.get(sourcePart);
	const definition = form.get("definition");
	if (!file || typeof file === "string" || !definition)
		throw new ContractError("INVALID_CONTRACT", "Provide a source file and JSON definition");
	if (sourcePart === "pdf") validatePdfUpload(file);
	let raw: unknown;
	try {
		raw = JSON.parse(
			typeof definition === "string" ? definition : await definition.text(),
		) as unknown;
	} catch {
		throw new ContractError("INVALID_CONTRACT", "The definition must contain valid JSON");
	}
	const parsed = MultipartContractSchema.safeParse(raw);
	if (!parsed.success)
		throw new ContractError("INVALID_CONTRACT", "Invalid recipients or field definitions");
	const contract = { ...parsed.data, kind: "placeholder" as const };
	if (sourcePart === "html") return { ...contract, html: await readHtmlUpload(file) };
	const bytes = new Uint8Array(await file.arrayBuffer());
	return { ...contract, pdf: { filename: file.name, base64: encodeContractPdf(bytes) } };
}

function validatePdfUpload(pdf: File): void {
	if (/\.html?$/i.test(pdf.name) || pdf.type.toLowerCase().startsWith("text/html"))
		throw new ContractError(
			"HTML_RENDERING_UNAVAILABLE",
			"The pdf part accepts PDF files. Use the html part when creating a contract from HTML",
		);
	if (!/\.pdf$/i.test(pdf.name) || pdf.size > MAX_CONTRACT_PDF_BYTES || pdf.size === 0)
		throw new ContractError(
			pdf.size > MAX_CONTRACT_PDF_BYTES ? "SOURCE_PDF_TOO_LARGE" : "INVALID_SOURCE_PDF",
			"Provide a non-empty PDF of at most 2 MiB",
			pdf.size > MAX_CONTRACT_PDF_BYTES ? 413 : 400,
		);
}

async function readHtmlUpload(file: File): Promise<HtmlContractRequest["html"]> {
	if (file.size > MAX_CONTRACT_HTML_BYTES)
		throw new ContractError("SOURCE_HTML_TOO_LARGE", "The source HTML must be at most 1 MiB", 413);
	if (!/\.html?$/i.test(file.name) || file.name.length > 255 || file.size === 0)
		throw new ContractError("INVALID_SOURCE_HTML", "Provide a non-empty UTF-8 .html or .htm file");
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
	} catch {
		throw new ContractError("INVALID_SOURCE_HTML", "The source HTML must be valid UTF-8");
	}
	if (!content.trim())
		throw new ContractError("INVALID_SOURCE_HTML", "Provide a non-empty HTML file");
	return { filename: file.name, content };
}

export function encodeContractPdf(bytes: Uint8Array): string {
	let binary = "";
	for (let start = 0; start < bytes.length; start += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
	return btoa(binary);
}
