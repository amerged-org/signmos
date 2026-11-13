import { eq } from "drizzle-orm";
import { getDb } from "@/db/setup";
import { createSignatureProfile } from "./preparation";
import {
	type CompleteSigningRequest,
	type CompleteSigningResult,
	type CompleteSigningSignature,
	EnvelopeFieldSchema,
	EnvelopeSchema,
	RecipientSchema,
} from "./schema";
import { SigningFieldValuesError } from "./signing-field-values";
import { auditEvents, envelopeFields, envelopeRecipients, envelopes, fieldValues } from "./table";

export class CreatorSigningBlockedError extends Error {
	constructor(public readonly code: "NOT_FOUND" | "NOT_DRAFT" | "NO_FIELDS" | "ALREADY_COMPLETED") {
		super(code);
		this.name = "CreatorSigningBlockedError";
	}
}

export async function completeDraftCreatorSigning(input: {
	envelopeId: string;
	creatorEmail: string;
	completion: CompleteSigningRequest;
	now?: Date;
}): Promise<CompleteSigningResult> {
	const db = getDb();
	const [row] = await db
		.select()
		.from(envelopes)
		.where(eq(envelopes.id, input.envelopeId))
		.limit(1);
	const envelope = row ? EnvelopeSchema.parse(row) : null;
	if (
		!envelope ||
		envelope.signingMode !== "me_and_another_signer" ||
		!sameEmail(envelope.createdBy, input.creatorEmail)
	) {
		throw new CreatorSigningBlockedError("NOT_FOUND");
	}
	if (envelope.status !== "draft") throw new CreatorSigningBlockedError("NOT_DRAFT");
	const recipients = (
		await db
			.select()
			.from(envelopeRecipients)
			.where(eq(envelopeRecipients.envelopeId, input.envelopeId))
			.limit(10)
	).map((recipient) => RecipientSchema.parse(recipient));
	const creator = recipients.find((recipient) => sameEmail(recipient.email, input.creatorEmail));
	if (!creator) throw new CreatorSigningBlockedError("NOT_FOUND");
	if (creator.status === "completed") throw new CreatorSigningBlockedError("ALREADY_COMPLETED");
	const fields = (
		await db
			.select()
			.from(envelopeFields)
			.where(eq(envelopeFields.envelopeId, input.envelopeId))
			.limit(100)
	)
		.map((field) => EnvelopeFieldSchema.parse(field))
		.filter((field) => field.recipientId === creator.id);
	if (fields.length === 0) throw new CreatorSigningBlockedError("NO_FIELDS");
	if (
		fields.some(
			(field) => field.isPlaceholder || (field.type !== "signature" && field.type !== "date"),
		)
	) {
		throw new SigningFieldValuesError("Creator custom fields require explicit completion");
	}
	if (!input.completion.signature && !input.completion.signatureName) {
		throw new SigningFieldValuesError("Signature is required");
	}
	const signature = normalizeSignature(input.completion);
	const signingDate = formatSigningDate(input.now ?? new Date());
	await db
		.insert(fieldValues)
		.values(
			fields.map((field) => ({
				envelopeId: input.envelopeId,
				recipientId: creator.id,
				fieldId: field.id,
				value: field.type === "signature" ? signature.value : signingDate,
			})),
		)
		.returning();
	await db
		.insert(auditEvents)
		.values([
			{
				envelopeId: input.envelopeId,
				recipientId: creator.id,
				eventType: "field.value.completed",
				message: signature.auditMessage,
			},
			{
				envelopeId: input.envelopeId,
				recipientId: creator.id,
				eventType: "sender.completed",
				message: normalizeEmail(input.creatorEmail),
			},
		])
		.returning();
	await db
		.update(envelopeRecipients)
		.set({ status: "completed" })
		.where(eq(envelopeRecipients.id, creator.id));
	if (input.completion.rememberSignature) {
		await createSignatureProfile({
			envelopeId: input.envelopeId,
			createdBy: input.creatorEmail,
			profile: signature.profile,
		});
	}
	return {
		envelopeId: input.envelopeId,
		recipientId: creator.id,
		recipientStatus: "completed",
		envelopeStatus: "draft",
	};
}

function normalizeSignature(input: CompleteSigningRequest): {
	value: string;
	auditMessage: string;
	profile: Parameters<typeof createSignatureProfile>[0]["profile"];
} {
	const signature = input.signature ?? legacySignature(input.signatureName);
	return signature.kind === "typed"
		? {
				value: signature.typedText,
				auditMessage: signature.typedText,
				profile: {
					kind: "typed",
					label: "Typed signature",
					typedText: signature.typedText,
					typedFont: signature.typedFont,
					selected: true,
				},
			}
		: {
				value: signature.svgPath,
				auditMessage: signature.label,
				profile: { ...signature, selected: true },
			};
}

function legacySignature(signatureName: string | undefined): CompleteSigningSignature {
	const typedText = signatureName?.trim();
	if (!typedText) throw new Error("Signature is required");
	return { kind: "typed", typedText, typedFont: "cursive" };
}

function formatSigningDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function sameEmail(left: string, right: string): boolean {
	return normalizeEmail(left) === normalizeEmail(right);
}
