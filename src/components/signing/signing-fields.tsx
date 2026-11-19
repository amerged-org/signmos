import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/lib/i18n";
import { signingCopy } from "./signing-copy";
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
	const { language } = useLanguage();
	const copy = signingCopy[language];
	if (fields.length === 0) return null;
	return (
		<fieldset className="grid gap-5">
			<legend className="mb-4 font-serif text-xl">{copy.yourDetails}</legend>
			{fields.map((field) => {
				const id = `signing-field-${field.id}`;
				const currentValue = values[field.id];
				const required = field.required !== false;
				const label = `${signerFieldLabel(field, language)}${required ? " *" : ` (${copy.optional})`}`;
				if (field.type === "checkbox") {
					return (
						<label
							key={field.id}
							className="flex min-h-11 items-center gap-3 border-b py-2 text-sm"
						>
							<input
								id={id}
								type="checkbox"
								checked={values[field.id] === true}
								required={required}
								onChange={(event) => onChange({ ...values, [field.id]: event.target.checked })}
								className="size-4 shrink-0 accent-foreground"
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
	const { language } = useLanguage();
	const copy = signingCopy[language];
	return fields.map((field) => (
		<label key={field.id} className="flex min-h-11 items-center gap-3 border-b py-2 text-sm">
			<input
				type="checkbox"
				className="size-4 shrink-0 accent-foreground"
				checked={values[field.id] === true}
				onChange={(event) => onChange({ ...values, [field.id]: event.target.checked })}
			/>
			{language === "en"
				? `${copy.add} ${signerFieldLabel(field, language)}`
				: `${signerFieldLabel(field, language)} ${copy.add}`}{" "}
			({copy.optional})
		</label>
	));
}
