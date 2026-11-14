import { z } from "zod";
import { MAX_DOCUMENT_FIELDS } from "@/db/envelope/pdf-policy-limits";
import {
	ContractError,
	MAX_CONTRACT_PDF_BYTES,
	MAX_CONTRACT_REQUEST_BYTES,
} from "./contracts-schema";

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

/** Bounded reads prevent an unauthenticated or chunked upload from exhausting worker memory. */
export async function readMultipartContract(request: Request): Promise<MultipartContractRequest> {
	const reader = request.body?.getReader();
	if (!reader) throw new ContractError("INVALID_CONTRACT", "A request body is required");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		size += result.value.byteLength;
		if (size > MAX_CONTRACT_REQUEST_BYTES) {
			await reader.cancel();
			throw new ContractError("SOURCE_PDF_TOO_LARGE", "The contract request is too large", 413);
		}
		chunks.push(result.value);
	}
	const data = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
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
	if (
		form.getAll("pdf").length !== 1 ||
		form.getAll("definition").length !== 1 ||
		[...form.keys()].some((key) => key !== "pdf" && key !== "definition")
	)
		throw new ContractError("INVALID_CONTRACT", "Provide exactly one pdf and one definition part");
	const pdf = form.get("pdf");
	const definition = form.get("definition");
	if (!pdf || typeof pdf === "string" || !definition)
		throw new ContractError("INVALID_CONTRACT", "Provide a PDF file and JSON definition");
	if (/\.html?$/i.test(pdf.name) || pdf.type.toLowerCase().startsWith("text/html"))
		throw new ContractError(
			"HTML_RENDERING_UNAVAILABLE",
			"HTML upload is not available; provide a PDF and JSON field definitions",
		);
	if (!/\.pdf$/i.test(pdf.name) || pdf.size > MAX_CONTRACT_PDF_BYTES || pdf.size === 0)
		throw new ContractError(
			pdf.size > MAX_CONTRACT_PDF_BYTES ? "SOURCE_PDF_TOO_LARGE" : "INVALID_SOURCE_PDF",
			"Provide a non-empty PDF of at most 2 MiB",
			pdf.size > MAX_CONTRACT_PDF_BYTES ? 413 : 400,
		);
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
	const bytes = new Uint8Array(await pdf.arrayBuffer());
	let binary = "";
	for (let start = 0; start < bytes.length; start += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
	return { ...parsed.data, kind: "placeholder", pdf: { filename: pdf.name, base64: btoa(binary) } };
}
