import { z } from "zod";
import { MAX_DOCUMENT_FIELDS, MAX_SOURCE_PDF_BYTES } from "@/db/envelope/pdf-policy-limits";

export const MAX_CONTRACT_PDF_BYTES = MAX_SOURCE_PDF_BYTES;
export const MAX_CONTRACT_REQUEST_BYTES = Math.ceil(MAX_CONTRACT_PDF_BYTES / 3) * 4 + 64 * 1024;

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
		public readonly status: 400 | 402 | 409 | 413 | 423 | 429 | 502 | 503 = 400,
	) {
		super(message);
		this.name = "ContractError";
	}
}
