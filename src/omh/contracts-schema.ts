import { z } from "zod";
import { MAX_DOCUMENT_FIELDS, MAX_SOURCE_PDF_BYTES } from "@/db/envelope/pdf-policy-limits";
import type { ContractDefinition } from "./contracts-draft-schema";

export const MAX_CONTRACT_PDF_BYTES = MAX_SOURCE_PDF_BYTES;
const MAX_CONTRACT_REQUEST_BYTES = Math.ceil(MAX_CONTRACT_PDF_BYTES / 3) * 4 + 64 * 1024;

/** Bound request bodies even when the client streams without a Content-Length. */
export async function readContractRequestBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
	const reader = request.body?.getReader();
	if (!reader) throw new ContractError("INVALID_CONTRACT", "A request body is required");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_CONTRACT_REQUEST_BYTES) {
			await reader.cancel();
			throw new ContractError("SOURCE_PDF_TOO_LARGE", "The contract request is too large", 413);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

const ContractFieldSchema = z
	.object({
		type: z.enum(["signature", "date"]),
		page: z.number().int().positive(),
		x: z.number().int().min(0),
		y: z.number().int().min(0),
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	})
	.strict()
	.refine((field) => field.x + field.width <= 612 && field.y + field.height <= 792, {
		message: "Fields must fit the 612 by 792 coordinate space",
	});

export const CreateContractSchema = z
	.object({
		title: z.string().trim().min(1).max(160),
		recipient: z
			.object({
				name: z.string().trim().min(1).max(120),
				email: z.email().trim().toLowerCase().max(254),
			})
			.strict(),
		pdf: z
			.object({
				filename: z
					.string()
					.trim()
					.min(1)
					.max(255)
					.regex(/\.pdf$/i),
				base64: z
					.string()
					.min(4)
					.max(Math.ceil(MAX_CONTRACT_PDF_BYTES / 3) * 4),
			})
			.strict(),
		fields: z.array(ContractFieldSchema).min(1).max(MAX_DOCUMENT_FIELDS).optional(),
	})
	.strict()
	.refine(
		(input) =>
			!input.fields || input.fields.filter((field) => field.type === "signature").length === 1,
		{
			message: "Custom placement requires exactly one signature field",
			path: ["fields"],
		},
	);

export type CreateContractRequest = z.infer<typeof CreateContractSchema>;
export type ContractField = z.infer<typeof ContractFieldSchema>;

export interface ContractSummary {
	definition?: ContractDefinition;
	id: string;
	title: string;
	status: string;
	recipients: Array<{ name: string; email: string; status: string }>;
	createdAt: string;
	completedAt: string | null;
	downloadUrl: string | null;
}

export class ContractError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: 400 | 404 | 409 | 413 | 502 | 503 = 400,
		public readonly details?: { retryAt: string; retryable: true },
	) {
		super(message);
		this.name = "ContractError";
	}
}
