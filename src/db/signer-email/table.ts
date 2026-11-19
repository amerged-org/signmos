import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { signerTokens } from "@/db/envelope/table";

export const signerEmailChallenges = pgTable("signer_email_challenges", {
	id: uuid("id").primaryKey(),
	tokenId: uuid("token_id")
		.notNull()
		.unique()
		.references(() => signerTokens.id, { onDelete: "cascade" }),
	email: text("email").notNull(),
	codeHash: text("code_hash").notNull(),
	attempts: integer("attempts").notNull().default(0),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const signerEmailSessions = pgTable("signer_email_sessions", {
	id: uuid("id").defaultRandom().primaryKey(),
	tokenId: uuid("token_id")
		.notNull()
		.references(() => signerTokens.id, { onDelete: "cascade" }),
	envelopeId: uuid("envelope_id").notNull(),
	recipientId: uuid("recipient_id").notNull(),
	email: text("email").notNull(),
	sessionHash: text("session_hash").notNull().unique(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
