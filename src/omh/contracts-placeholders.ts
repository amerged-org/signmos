import {
	assertPdfFieldCount,
	loadValidatedSourcePdf,
	PdfPolicyError,
} from "@/db/envelope/pdf-policy";
import { isPdf } from "@/hono/api/envelope-route-helpers";
import type { MultipartContractRequest } from "./contracts-multipart";
import { decodePdf } from "./contracts-pdf";
import { ContractError } from "./contracts-schema";
import { extractPdfPlaceholders, PdfPlaceholderError } from "./pdf-placeholders";

export async function preparePlaceholderContract(request: MultipartContractRequest) {
	const bytes = decodePdf(request.pdf.base64);
	if (!isPdf(bytes)) throw new ContractError("INVALID_SOURCE_PDF", "Source document must be a PDF");
	try {
		await loadValidatedSourcePdf(bytes);
		const placeholders = await extractPdfPlaceholders(bytes);
		assertPdfFieldCount(placeholders.length);
		const keys = new Set(placeholders.map((field) => `${field.recipient}.${field.name}`));
		if (
			!placeholders.length ||
			placeholders.some(
				(field) =>
					!request.fields.some(
						(definition) =>
							definition.recipient === field.recipient && definition.name === field.name,
					),
			) ||
			request.fields.some((definition) => !keys.has(`${definition.recipient}.${definition.name}`))
		)
			throw new ContractError(
				"INVALID_FIELDS",
				"Every PDF placeholder must have a matching JSON field definition and vice versa",
			);
		return {
			bytes,
			fields: placeholders.map(({ marker: _marker, ...position }) => {
				const definition = request.fields.find(
					(field) => field.recipient === position.recipient && field.name === position.name,
				);
				if (!definition)
					throw new ContractError("INVALID_FIELDS", "A placeholder has no field definition");
				return {
					...position,
					type: definition.type,
					label: definition.label,
					required: definition.required,
					isPlaceholder: true,
				};
			}),
		};
	} catch (error) {
		if (error instanceof PdfPolicyError)
			throw new ContractError(error.code, error.message, error.status);
		if (error instanceof PdfPlaceholderError)
			throw new ContractError("INVALID_PLACEHOLDERS", error.message);
		throw error;
	}
}
