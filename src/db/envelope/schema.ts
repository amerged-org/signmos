import { z } from "zod";
import { MAX_DOCUMENT_FIELDS, MAX_SOURCE_PDF_PAGES } from "./pdf-policy-limits";
import {
	envelopeStatuses,
	fieldTypes,
	recipientStatuses,
	senderVerificationStatuses,
	signatureProfileKinds,
	signingModes,
} from "./table";

export const envelopeLifecycleActions = ["send", "cancel", "expire", "delete"] as const;
export const envelopeAllowedActionsByStatus = {
	awaiting_verification: ["verify_sender_email"],
	draft: ["upload_source_pdf", "add_recipients", "add_fields", "send"],
	changes_requested: ["upload_revised_source_pdf", "cancel", "expire", "delete"],
	sent: ["view_signing_status", "resend_invitation", "cancel", "expire", "delete"],
	completed: ["download_final_pdf", "delete"],
	declined: [],
	expired: ["delete"],
	deleted: [],
} as const satisfies Record<EnvelopeStatus, readonly string[]>;

export const EnvelopeStatusSchema = z.enum(envelopeStatuses);
export type EnvelopeStatus = z.infer<typeof EnvelopeStatusSchema>;
export const SigningModeSchema = z.enum(signingModes);
export type SigningMode = z.infer<typeof SigningModeSchema>;

export const RecipientStatusSchema = z.enum(recipientStatuses);
export type RecipientStatus = z.infer<typeof RecipientStatusSchema>;

export const SenderVerificationStatusSchema = z.enum(senderVerificationStatuses);
export type SenderVerificationStatus = z.infer<typeof SenderVerificationStatusSchema>;

export const FieldTypeSchema = z.enum(fieldTypes);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const SignatureProfileKindSchema = z.enum(signatureProfileKinds);
export type SignatureProfileKind = z.infer<typeof SignatureProfileKindSchema>;

export const EnvelopeLifecycleActionSchema = z.enum(envelopeLifecycleActions);
export type EnvelopeLifecycleAction = z.infer<typeof EnvelopeLifecycleActionSchema>;

export const EnvelopeSchema = z.object({
	id: z.string().uuid(),
	status: EnvelopeStatusSchema,
	signingMode: SigningModeSchema.default("me_and_another_signer"),
	createdBy: z.string().min(1),
	createdByName: z.string().nullable().optional(),
	createdAt: z.date(),
	sentBy: z.string().nullable().optional(),
	sentAt: z.date().nullable().optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const CreateEnvelopeInputSchema = z.object({
	createdBy: z.string().min(1),
	idempotencyKey: z.string().min(1).optional(),
});
export type CreateEnvelopeInput = z.infer<typeof CreateEnvelopeInputSchema>;

export const EnvelopeResponseSchema = z.object({
	id: z.string().uuid(),
	status: EnvelopeStatusSchema,
	createdBy: z.string(),
	createdAt: z.string(),
});
export type EnvelopeResponse = z.infer<typeof EnvelopeResponseSchema>;

export const EnvelopeActionRequestSchema = z.object({
	action: EnvelopeLifecycleActionSchema,
});
export type EnvelopeActionInput = z.infer<typeof EnvelopeActionRequestSchema>;
export const SourceDocumentSchema = z.object({
	id: z.string().uuid(),
	envelopeId: z.string().uuid(),
	r2Key: z.string().min(1),
	version: z.coerce.number().int().positive().default(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	byteSize: z.coerce.number().int().nonnegative(),
	contentType: z.literal("application/pdf"),
	originalFilename: z.string().min(1).default("document.pdf"),
	uploadedBy: z.string().min(1),
	uploadedAt: z.date(),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export const AttachSourceDocumentInputSchema = z.object({
	envelopeId: z.string().uuid(),
	uploadedBy: z.string().min(1),
	idempotencyKey: z.string().min(1).optional(),
	r2Key: z.string().min(1),
	version: z.number().int().positive().optional(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	byteSize: z.number().int().nonnegative(),
	contentType: z.literal("application/pdf"),
	originalFilename: z.string().min(1).default("document.pdf"),
});
export type AttachSourceDocumentInput = z.infer<typeof AttachSourceDocumentInputSchema>;
export const SourceDocumentResponseSchema = z.object({
	id: z.string().uuid(),
	envelopeId: z.string().uuid(),
	r2Key: z.string(),
	version: z.number(),
	sha256: z.string(),
	byteSize: z.number(),
	contentType: z.literal("application/pdf"),
	originalFilename: z.string(),
	uploadedBy: z.string(),
	uploadedAt: z.string(),
});
export type SourceDocumentResponse = z.infer<typeof SourceDocumentResponseSchema>;
export const SenderStartRequestSchema = z.object({
	signingMode: SigningModeSchema.default("me_and_another_signer"),
	name: z.string().trim().min(1).max(120),
	email: z.string().trim().toLowerCase().email(),
	turnstileToken: z.string().min(1),
});
export type SenderStartRequest = z.infer<typeof SenderStartRequestSchema>;

export const SenderVerificationTokenSchema = z.object({
	id: z.string().uuid(),
	envelopeId: z.string().uuid(),
	name: z.string().min(1),
	email: z.string().email(),
	token: z.string().min(1),
	status: SenderVerificationStatusSchema,
	expiresAt: z.date(),
	verifiedAt: z.date().nullable().optional(),
	createdAt: z.date(),
});
export type SenderVerificationToken = z.infer<typeof SenderVerificationTokenSchema>;

export const SenderStartResponseSchema = z.object({
	envelopeId: z.string().uuid(),
	status: z.literal("awaiting_verification"),
	signingMode: SigningModeSchema,
	sender: z.object({
		name: z.string(),
		email: z.string().email(),
	}),
	allowedActions: z.array(z.string()),
	verification: z.object({
		email: z.string().email(),
		expiresAt: z.string(),
		fallbackUrl: z.string().min(1),
	}),
});
export type SenderStartResponse = z.infer<typeof SenderStartResponseSchema>;

export const SenderVerificationResponseSchema = z.object({
	envelopeId: z.string().uuid(),
	status: z.literal("draft"),
	signingMode: SigningModeSchema,
	senderSessionToken: z.string().min(1),
	sender: z.object({
		name: z.string(),
		email: z.string().email(),
	}),
	allowedActions: z.array(z.string()),
	verifiedAt: z.string(),
});
export type SenderVerificationResponse = z.infer<typeof SenderVerificationResponseSchema>;

export const FinalDocumentSchema = z.object({
	id: z.string().uuid().optional(),
	envelopeId: z.string().uuid(),
	r2Key: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	byteSize: z.coerce.number().int().nonnegative(),
	contentType: z.literal("application/pdf"),
	createdAt: z.date().optional(),
});
export type FinalDocument = z.infer<typeof FinalDocumentSchema>;

export const RecipientSchema = z.object({
	id: z.string().uuid(),
	envelopeId: z.string().uuid(),
	name: z.string().min(1),
	email: z.string().email(),
	status: RecipientStatusSchema,
	createdAt: z.date(),
});
export type Recipient = z.infer<typeof RecipientSchema>;

export const RecipientCreateSchema = z.object({
	name: z.string().min(1).max(120),
	email: z.string().email(),
});
export type RecipientCreateInput = z.infer<typeof RecipientCreateSchema>;

export const AddRecipientsRequestSchema = z.object({
	recipients: z.array(RecipientCreateSchema).min(1).max(10),
});
export type AddRecipientsRequest = z.infer<typeof AddRecipientsRequestSchema>;

export const RecipientResponseSchema = z.object({
	id: z.string().uuid(),
	envelopeId: z.string().uuid(),
	name: z.string(),
	email: z.string(),
	status: RecipientStatusSchema,
	createdAt: z.string(),
});
export type RecipientResponse = z.infer<typeof RecipientResponseSchema>;

export const SignatureProfileSchema = z.object({
	id: z.string().uuid(),
	envelopeId: z.string().uuid(),
	createdBy: z.string().min(1),
	kind: SignatureProfileKindSchema,
	label: z.string().min(1),
	svgPath: z.string().nullable().optional(),
	typedText: z.string().nullable().optional(),
	typedFont: z.string().nullable().optional(),
	selected: z.boolean(),
	createdAt: z.date(),
});
export type SignatureProfile = z.infer<typeof SignatureProfileSchema>;

export const SignatureProfileCreateRequestSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("drawn"),
		label: z.string().min(1).max(120),
		svgPath: z.string().min(1),
		selected: z.boolean().optional().default(true),
	}),
	z.object({
		kind: z.literal("typed"),
		label: z.string().min(1).max(120),
		typedText: z.string().min(1).max(120),
		typedFont: z.string().min(1).max(80).default("serif"),
		selected: z.boolean().optional().default(true),
	}),
]);
export type SignatureProfileCreateRequest = z.infer<typeof SignatureProfileCreateRequestSchema>;

export const SignatureProfileResponseSchema = SignatureProfileSchema.extend({
	svgPath: z.string().nullable(),
	typedText: z.string().nullable(),
	typedFont: z.string().nullable(),
	createdAt: z.string(),
});
export type SignatureProfileResponse = z.infer<typeof SignatureProfileResponseSchema>;

export const SendEnvelopeResultSchema = z.object({
	envelopeId: z.string().uuid(),
	status: z.literal("sent"),
	sentBy: z.string().min(1),
	tokenCount: z.number().int().nonnegative(),
	emailSendCount: z.number().int().nonnegative(),
	verificationLinks: z.array(
		z.object({
			recipientId: z.string().uuid(),
			email: z.string().email(),
			token: z.string().min(1),
			url: z.string().min(1),
			expiresAt: z.string().min(1),
		}),
	),
});
export type SendEnvelopeResult = z.infer<typeof SendEnvelopeResultSchema>;

export const ResendInvitationResultSchema = z.object({
	recipientId: z.string().uuid(),
	email: z.string().email(),
	emailSendCount: z.number().int().positive(),
});
export type ResendInvitationResult = z.infer<typeof ResendInvitationResultSchema>;

export const SignerTokenSchema = z.object({
	id: z.string().uuid(),
	envelopeId: z.string().uuid(),
	recipientId: z.string().uuid(),
	token: z.string().min(1),
	status: z.enum(["active", "revoked"]),
	expiresAt: z.date(),
	verifiedAt: z.date().nullable().optional(),
	createdAt: z.date(),
});
export type SignerToken = z.infer<typeof SignerTokenSchema>;

export const SignerSessionFieldSchema = z.object({
	id: z.string().uuid(),
	type: FieldTypeSchema,
	page: z.number(),
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});
export type SignerSessionField = z.infer<typeof SignerSessionFieldSchema>;

export const SignerPreviewFieldSchema = SignerSessionFieldSchema.extend({
	recipientId: z.string().uuid(),
	recipientName: z.string().min(1),
	value: z.string().nullable(),
	assignedToCurrentSigner: z.boolean(),
});
export type SignerPreviewField = z.infer<typeof SignerPreviewFieldSchema>;

export const SignerSessionSchema = z.object({
	envelopeId: z.string().uuid(),
	recipientId: z.string().uuid(),
	signingMode: SigningModeSchema,
	sourceDocument: z.object({
		version: z.number().int().positive(),
		contentType: z.literal("application/pdf"),
		downloadUrl: z.string().min(1),
	}),
	fields: z.array(SignerSessionFieldSchema),
	previewFields: z.array(SignerPreviewFieldSchema),
	signaturePreference: SignatureProfileResponseSchema.nullable(),
});
export type SignerSession = z.infer<typeof SignerSessionSchema>;

export const CompleteSigningSignatureSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("typed"),
		typedText: z.string().trim().min(1).max(120),
		typedFont: z.string().trim().min(1).max(80).default("cursive"),
	}),
	z.object({
		kind: z.literal("drawn"),
		label: z.string().trim().min(1).max(120).default("Drawn signature"),
		svgPath: z.string().trim().min(1),
	}),
]);
export type CompleteSigningSignature = z.infer<typeof CompleteSigningSignatureSchema>;
export const CompleteSigningRequestSchema = z
	.object({
		signatureName: z.string().trim().min(1).optional(),
		signature: CompleteSigningSignatureSchema.optional(),
		rememberSignature: z.boolean().default(false),
		date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.optional(),
	})
	.refine((input) => input.signature || input.signatureName, {
		message: "Signature is required",
		path: ["signature"],
	});
export type CompleteSigningRequest = z.infer<typeof CompleteSigningRequestSchema>;

export const CompleteSigningResultSchema = z.object({
	envelopeId: z.string().uuid(),
	recipientId: z.string().uuid(),
	recipientStatus: z.literal("completed"),
	envelopeStatus: EnvelopeStatusSchema,
});
export type CompleteSigningResult = z.infer<typeof CompleteSigningResultSchema>;

export const DeclineSigningRequestSchema = z.object({
	reason: z.string().min(1),
	comment: z.string().min(1).optional(),
});
export type DeclineSigningRequest = z.infer<typeof DeclineSigningRequestSchema>;

export const ChangeRequestSigningRequestSchema = z.object({
	comment: z.string().min(1),
});
export type ChangeRequestSigningRequest = z.infer<typeof ChangeRequestSigningRequestSchema>;

export const DeclineSigningResultSchema = z.object({
	envelopeId: z.string().uuid(),
	recipientId: z.string().uuid(),
	recipientStatus: z.literal("declined"),
	envelopeStatus: z.literal("declined"),
});
export type DeclineSigningResult = z.infer<typeof DeclineSigningResultSchema>;

export const ChangeRequestSigningResultSchema = z.object({
	envelopeId: z.string().uuid(),
	recipientId: z.string().uuid(),
	recipientStatus: z.literal("sent"),
	envelopeStatus: z.literal("changes_requested"),
	allowedActions: z.array(z.string()),
});
export type ChangeRequestSigningResult = z.infer<typeof ChangeRequestSigningResultSchema>;

export const EnvelopeFieldSchema = z.object({
	id: z.string().uuid(),
	envelopeId: z.string().uuid(),
	recipientId: z.string().uuid(),
	type: FieldTypeSchema,
	page: z.coerce.number().int().min(1),
	x: z.coerce.number().int().min(0),
	y: z.coerce.number().int().min(0),
	width: z.coerce.number().int().positive(),
	height: z.coerce.number().int().positive(),
	createdAt: z.date(),
});
export type EnvelopeField = z.infer<typeof EnvelopeFieldSchema>;

export const FieldValueSchema = z.object({
	id: z.string().uuid().optional(),
	envelopeId: z.string().uuid(),
	recipientId: z.string().uuid(),
	fieldId: z.string().uuid(),
	value: z.string(),
	completedAt: z.date().optional(),
});
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const FieldCreateSchema = z.object({
	recipientId: z.string().uuid(),
	type: FieldTypeSchema,
	page: z.number().int().min(1).max(MAX_SOURCE_PDF_PAGES),
	x: z.number().int().min(0),
	y: z.number().int().min(0),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});
export type FieldCreateInput = z.infer<typeof FieldCreateSchema>;

export const AddFieldsRequestSchema = z.object({
	fields: z.array(FieldCreateSchema).min(1).max(MAX_DOCUMENT_FIELDS),
});
export type AddFieldsRequest = z.infer<typeof AddFieldsRequestSchema>;

export const DefaultFieldPlacementRequestSchema = z.object({
	recipientIds: z.array(z.string().uuid()).min(1).max(10),
	page: z.number().int().min(1).max(MAX_SOURCE_PDF_PAGES).optional().default(1),
});
export type DefaultFieldPlacementRequest = z.infer<typeof DefaultFieldPlacementRequestSchema>;

export const EnvelopeFieldResponseSchema = EnvelopeFieldSchema.extend({
	createdAt: z.string(),
});
export type EnvelopeFieldResponse = z.infer<typeof EnvelopeFieldResponseSchema>;

export function toEnvelopeResponse(envelope: Envelope): EnvelopeResponse {
	return {
		id: envelope.id,
		status: envelope.status,
		createdBy: envelope.createdBy,
		createdAt: envelope.createdAt.toISOString(),
	};
}

export function toSourceDocumentResponse(document: SourceDocument): SourceDocumentResponse {
	return {
		id: document.id,
		envelopeId: document.envelopeId,
		r2Key: document.r2Key,
		version: document.version,
		sha256: document.sha256,
		byteSize: document.byteSize,
		contentType: document.contentType,
		originalFilename: document.originalFilename,
		uploadedBy: document.uploadedBy,
		uploadedAt: document.uploadedAt.toISOString(),
	};
}

export function getEnvelopeAllowedActions(status: EnvelopeStatus): string[] {
	return [...envelopeAllowedActionsByStatus[status]];
}

export function toRecipientResponse(recipient: Recipient): RecipientResponse {
	return {
		id: recipient.id,
		envelopeId: recipient.envelopeId,
		name: recipient.name,
		email: recipient.email,
		status: recipient.status,
		createdAt: recipient.createdAt.toISOString(),
	};
}

export function toEnvelopeFieldResponse(field: EnvelopeField): EnvelopeFieldResponse {
	return {
		id: field.id,
		envelopeId: field.envelopeId,
		recipientId: field.recipientId,
		type: field.type,
		page: field.page,
		x: field.x,
		y: field.y,
		width: field.width,
		height: field.height,
		createdAt: field.createdAt.toISOString(),
	};
}

export function toSignatureProfileResponse(profile: SignatureProfile): SignatureProfileResponse {
	return {
		id: profile.id,
		envelopeId: profile.envelopeId,
		createdBy: profile.createdBy,
		kind: profile.kind,
		label: profile.label,
		svgPath: profile.svgPath ?? null,
		typedText: profile.typedText ?? null,
		typedFont: profile.typedFont ?? null,
		selected: profile.selected,
		createdAt: profile.createdAt.toISOString(),
	};
}
