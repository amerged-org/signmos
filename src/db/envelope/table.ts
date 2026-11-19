import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const envelopeStatuses = [
	"awaiting_verification",
	"preparing",
	"queued",
	"draft",
	"changes_requested",
	"sent",
	"completed",
	"declined",
	"expired",
	"deleted",
] as const;
export const signingModes = ["only_me", "me_and_another_signer"] as const;
export const recipientStatuses = ["pending", "sent", "completed", "declined"] as const;
export const senderVerificationStatuses = ["pending", "verified", "expired"] as const;
export const fieldTypes = ["signature", "date", "text", "checkbox"] as const;
export const signatureProfileKinds = ["drawn", "typed"] as const;

export const envelopes = pgTable("envelopes", {
	id: uuid("id").defaultRandom().primaryKey(),
	status: text("status").notNull().default("draft"),
	signingMode: text("signing_mode").notNull().default("me_and_another_signer"),
	createdBy: text("created_by").notNull(),
	createdByName: text("created_by_name"),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	sentBy: text("sent_by"),
	sentAt: timestamp("sent_at", { withTimezone: true }),
});

export const idempotencyRecords = pgTable(
	"idempotency_records",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		key: text("key").notNull(),
		operation: text("operation").notNull(),
		createdBy: text("created_by").notNull(),
		envelopeId: uuid("envelope_id")
			.notNull()
			.references(() => envelopes.id),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("idempotency_records_key_operation_created_by_unique").on(
			table.key,
			table.operation,
			table.createdBy,
		),
	],
);

export const senderVerificationTokens = pgTable("sender_verification_tokens", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	name: text("name").notNull(),
	email: text("email").notNull(),
	token: text("token").notNull().unique(),
	status: text("status").notNull().default("pending"),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	verifiedAt: timestamp("verified_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const senderVerificationEmailRecords = pgTable("sender_verification_email_records", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	tokenId: uuid("token_id")
		.notNull()
		.references(() => senderVerificationTokens.id),
	email: text("email").notNull(),
	kind: text("kind").notNull(),
	fallbackUrl: text("fallback_url"),
	sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
});

export const rateLimitRecords = pgTable(
	"rate_limit_records",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		key: text("key").notNull(),
		operation: text("operation").notNull(),
		attempts: integer("attempts").notNull(),
		resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("rate_limit_records_key_operation_unique").on(table.key, table.operation),
	],
);

export const sourceDocuments = pgTable("source_documents", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	r2Key: text("r2_key").notNull().unique(),
	version: integer("version").notNull().default(1),
	sha256: text("sha256").notNull(),
	byteSize: integer("byte_size").notNull(),
	contentType: text("content_type").notNull(),
	originalFilename: text("original_filename").notNull().default("document.pdf"),
	uploadedBy: text("uploaded_by").notNull(),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
});

export const finalDocuments = pgTable("final_documents", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	r2Key: text("r2_key").notNull().unique(),
	sha256: text("sha256").notNull(),
	byteSize: integer("byte_size").notNull(),
	contentType: text("content_type").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const envelopeRecipients = pgTable("envelope_recipients", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	name: text("name").notNull(),
	email: text("email").notNull(),
	status: text("status").notNull().default("pending"),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const signatureProfiles = pgTable("signature_profiles", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	createdBy: text("created_by").notNull(),
	kind: text("kind").notNull(),
	label: text("label").notNull(),
	svgPath: text("svg_path"),
	typedText: text("typed_text"),
	typedFont: text("typed_font"),
	selected: boolean("selected").notNull().default(true),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const signerTokens = pgTable("signer_tokens", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	recipientId: uuid("recipient_id")
		.notNull()
		.references(() => envelopeRecipients.id),
	token: text("token").notNull().unique(),
	status: text("status").notNull().default("active"),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	verifiedAt: timestamp("verified_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const emailSendRecords = pgTable("email_send_records", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	recipientId: uuid("recipient_id")
		.notNull()
		.references(() => envelopeRecipients.id),
	tokenId: uuid("token_id")
		.notNull()
		.references(() => signerTokens.id),
	email: text("email").notNull(),
	kind: text("kind").notNull(),
	fallbackUrl: text("fallback_url"),
	sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
});

export const envelopeFields = pgTable("envelope_fields", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	recipientId: uuid("recipient_id")
		.notNull()
		.references(() => envelopeRecipients.id),
	type: text("type").notNull(),
	name: text("name"),
	label: text("label"),
	required: boolean("required"),
	isPlaceholder: boolean("is_placeholder"),
	page: integer("page").notNull(),
	x: integer("x").notNull(),
	y: integer("y").notNull(),
	width: integer("width").notNull(),
	height: integer("height").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fieldValues = pgTable("field_values", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	recipientId: uuid("recipient_id")
		.notNull()
		.references(() => envelopeRecipients.id),
	fieldId: uuid("field_id")
		.notNull()
		.references(() => envelopeFields.id),
	value: text("value").notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const auditEvents = pgTable("audit_events", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	recipientId: uuid("recipient_id").references(() => envelopeRecipients.id),
	eventType: text("event_type").notNull(),
	message: text("message"),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
