import { z } from "zod";
import {
	encodeContractPdf,
	type HtmlContractRequest,
	type MultipartContractRequest,
	MultipartContractSchema,
	readMultipartContract,
} from "./contracts-multipart";
import { prepareContractPdf } from "./contracts-pdf";
import { preparePlaceholderContract } from "./contracts-placeholders";
import {
	ContractError,
	type CreateContractRequest,
	CreateContractSchema,
	readContractRequestBody,
} from "./contracts-schema";

export type DraftContractRequest = CreateContractRequest | MultipartContractRequest;
export const DraftContractJsonSchema = z.union([
	CreateContractSchema,
	MultipartContractSchema.safeExtend({
		pdf: CreateContractSchema.shape.pdf,
		kind: z.literal("placeholder").optional(),
	}),
]);
export type ContractDefinition =
	| (Omit<CreateContractRequest, "pdf"> & { pdf: { filename: string } })
	| (Omit<MultipartContractRequest, "pdf"> & { pdf: { filename: string } });
export const PatchContractSchema = z
	.object({
		title: CreateContractSchema.shape.title.optional(),
		recipient: CreateContractSchema.shape.recipient.optional(),
		recipients: MultipartContractSchema.shape.recipients.optional(),
		fields: z
			.union([CreateContractSchema.shape.fields.unwrap(), MultipartContractSchema.shape.fields])
			.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Supply a draft change");
export type PatchContractRequest = z.infer<typeof PatchContractSchema>;
export const SendContractSchema = z.object({ delivery: z.enum(["email", "manual"]) }).strict();

export async function readContractJson(request: Request): Promise<unknown> {
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
		throw new ContractError("INVALID_CONTRACT", "Use Content-Type: application/json");
	const bytes = await readContractRequestBody(request);
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new ContractError("INVALID_CONTRACT", "Supply valid JSON");
	}
}

export async function readDraftContract(
	request: Request,
	allowHtml: boolean,
): Promise<DraftContractRequest | HtmlContractRequest> {
	if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data"))
		return readMultipartContract(request, allowHtml);
	return parseDraftContract(await readContractJson(request));
}

export function parseDraftContract(value: unknown): DraftContractRequest {
	if (value && typeof value === "object" && "recipients" in value) {
		const { pdf, kind: _kind, ...definition } = value as Record<string, unknown>;
		if (_kind !== undefined && _kind !== "placeholder")
			throw new ContractError("INVALID_CONTRACT", "Use kind=placeholder for PDF definitions");
		const parsed = MultipartContractSchema.safeParse(definition);
		const file = CreateContractSchema.shape.pdf.safeParse(pdf);
		if (parsed.success && file.success)
			return { ...parsed.data, kind: "placeholder", pdf: file.data };
		if (!parsed.success) throwRequestLimit(parsed.error);
		if (!file.success) throwRequestLimit(file.error);
	} else {
		const parsed = CreateContractSchema.safeParse(value);
		if (parsed.success) return parsed.data;
		throwRequestLimit(parsed.error);
	}
	throw new ContractError(
		"INVALID_CONTRACT",
		"Supply a PDF, title, recipients and matching field definitions",
	);
}

function throwRequestLimit(error: z.ZodError): void {
	for (const issue of error.issues) {
		if (issue.code !== "too_big") continue;
		if (issue.path.at(-1) === "base64")
			throw new ContractError("SOURCE_PDF_TOO_LARGE", "The source PDF must be at most 2 MiB", 413);
		if (issue.path.at(-1) === "fields")
			throw new ContractError(
				"SOURCE_PDF_TOO_MANY_FIELDS",
				"A document can have at most 20 signing fields",
				413,
			);
	}
}

export async function prepareDraftContract(request: DraftContractRequest) {
	if ("kind" in request) {
		const prepared = await preparePlaceholderContract(request);
		const { pdf, ...definition } = request;
		return {
			...prepared,
			definition: { ...definition, pdf: { filename: pdf.filename } } satisfies ContractDefinition,
			recipients: request.recipients,
		};
	}
	const prepared = await prepareContractPdf(request);
	return {
		bytes: prepared.bytes,
		fields: prepared.fields.map((field) => ({ ...field, recipient: 1 })),
		definition: {
			...request,
			pdf: { filename: request.pdf.filename },
			fields: prepared.fields,
		} satisfies ContractDefinition,
		recipients: [{ ...request.recipient, index: 1 }],
	};
}

export function requestWithPdf(
	definition: ContractDefinition,
	bytes: Uint8Array,
): DraftContractRequest {
	return parseDraftContract({
		...definition,
		pdf: { filename: definition.pdf.filename, base64: encodeContractPdf(bytes) },
	});
}
