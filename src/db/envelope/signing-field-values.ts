import { supportsPlaceholderText } from "./placeholder-font";
import type { CompleteSigningRequest, EnvelopeField } from "./schema";

export class SigningFieldValuesError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SigningFieldValuesError";
	}
}

/** Validates only fields belonging to the signer and expands repeated PDF markers. */
export function resolveSigningFieldValues(
	fields: EnvelopeField[],
	input: CompleteSigningRequest,
	signatureValue: string | undefined,
	signingDate: string,
): Map<string, string> {
	const submitted = input.fieldValues ?? {};
	const ids = new Set(fields.map((field) => field.id));
	if (Object.keys(submitted).some((id) => !ids.has(id))) {
		throw new SigningFieldValuesError("A field does not belong to this recipient");
	}
	const byGroup = new Map<string, string>();
	const signatureGroups = new Map<string, boolean>();
	const values = new Map<string, string>();
	for (const field of fields) {
		const raw = submitted[field.id];
		if (field.type === "signature") {
			if (raw === undefined) continue;
			if (typeof raw !== "boolean")
				throw new SigningFieldValuesError("Invalid signature selection");
			const key = field.name ?? field.id;
			if (signatureGroups.has(key) && signatureGroups.get(key) !== raw) {
				throw new SigningFieldValuesError(`Conflicting values for ${field.label ?? key}`);
			}
			signatureGroups.set(key, raw);
			continue;
		}
		if (field.type === "date" && !field.name) continue;
		if (raw === undefined) continue;
		if (field.type === "checkbox" ? typeof raw !== "boolean" : typeof raw !== "string") {
			throw new SigningFieldValuesError(
				`Invalid value for ${field.label ?? field.name ?? "field"}`,
			);
		}
		const value = typeof raw === "string" ? raw.trim() : String(raw);
		const key = field.name ?? field.id;
		if (byGroup.has(key) && byGroup.get(key) !== value) {
			throw new SigningFieldValuesError(`Conflicting values for ${field.label ?? key}`);
		}
		byGroup.set(key, value);
	}
	for (const field of fields) {
		const selected = field.required || signatureGroups.get(field.name ?? field.id) === true;
		if (field.type === "signature" && selected && !signatureValue) {
			throw new SigningFieldValuesError(`${field.label ?? field.name ?? "signature"} is required`);
		}
		const value =
			field.type === "signature"
				? selected
					? (signatureValue ?? "")
					: ""
				: field.type === "date" && !field.name
					? signingDate
					: (byGroup.get(field.name ?? field.id) ?? "");
		if (field.required && (!value || (field.type === "checkbox" && value !== "true"))) {
			throw new SigningFieldValuesError(`${field.label ?? field.name ?? field.type} is required`);
		}
		if (field.type === "date" && value && !validDate(value)) {
			throw new SigningFieldValuesError(
				`${field.label ?? field.name ?? "Date"} must be a valid date`,
			);
		}
		if (
			field.isPlaceholder &&
			value &&
			(field.type === "text" ||
				(field.type === "signature" &&
					(input.signature?.kind === "typed" || input.signatureName))) &&
			!supportsPlaceholderText(value)
		) {
			throw new SigningFieldValuesError(
				`${field.label ?? field.name ?? "Field"} contains unsupported characters`,
			);
		}
		values.set(field.id, value);
	}
	return values;
}

function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
