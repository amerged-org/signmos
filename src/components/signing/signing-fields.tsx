import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type SignerField, signerFieldLabel } from "./signing-document-preview";

export type SigningFieldValues = Record<string, string | boolean>;

// A name identifies one logical field even if its marker appears more than once.
export function editableSigningFields(fields: SignerField[]): SignerField[] {
	const seen = new Set<string>();
	return fields.filter((field) => {
		if (field.type === "signature" || (field.type === "date" && !field.name)) return false;
		const key = field.name ? `${field.type}:${field.name}` : field.id;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function optionalSignatureFields(fields: SignerField[]): SignerField[] {
	const seen = new Set<string>();
	return fields.filter((field) => {
		if (field.type !== "signature" || field.required !== false) return false;
		const key = field.name ?? field.id;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function SigningFields({
	fields,
	values,
	onChange,
}: {
	fields: SignerField[];
	values: SigningFieldValues;
	onChange: (values: SigningFieldValues) => void;
}) {
	if (fields.length === 0) return null;
	return (
		<fieldset className="grid gap-4 md:grid-cols-2">
			<legend className="mb-3 font-medium">Deine Angaben</legend>
			{fields.map((field) => {
				const id = `signing-field-${field.id}`;
				const currentValue = values[field.id];
				const required = field.required !== false;
				const label = `${signerFieldLabel(field)}${required ? " *" : " (optional)"}`;
				if (field.type === "checkbox") {
					return (
						<label key={field.id} className="flex min-h-9 items-center gap-2 text-sm">
							<input
								id={id}
								type="checkbox"
								checked={values[field.id] === true}
								required={required}
								onChange={(event) => onChange({ ...values, [field.id]: event.target.checked })}
								className="size-4 rounded border-input"
							/>
							{label}
						</label>
					);
				}
				return (
					<div key={field.id} className="space-y-2">
						<Label htmlFor={id}>{label}</Label>
						<Input
							id={id}
							type={field.type === "date" ? "date" : "text"}
							value={typeof currentValue === "string" ? currentValue : ""}
							required={required}
							onChange={(event) => onChange({ ...values, [field.id]: event.target.value })}
						/>
					</div>
				);
			})}
		</fieldset>
	);
}

export function OptionalSignatures({
	fields,
	values,
	onChange,
}: {
	fields: SignerField[];
	values: SigningFieldValues;
	onChange: (values: SigningFieldValues) => void;
}) {
	return fields.map((field) => (
		<label key={field.id} className="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={values[field.id] === true}
				onChange={(event) => onChange({ ...values, [field.id]: event.target.checked })}
			/>
			{signerFieldLabel(field)} hinzufügen (optional)
		</label>
	));
}
