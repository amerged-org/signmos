import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { envelopeRecipients, envelopes, signerTokens } from "@/db/envelope/table";

/** Transactional invitation intent, committed before any message leaves the application. */
export const contractInvitationOutbox = pgTable(
	"contract_invitation_outbox",
	{
		id: uuid("id").primaryKey(),
		envelopeId: uuid("envelope_id")
			.notNull()
			.references(() => envelopes.id, { onDelete: "cascade" }),
		recipientId: uuid("recipient_id")
			.notNull()
			.references(() => envelopeRecipients.id, { onDelete: "cascade" }),
		tokenId: uuid("token_id")
			.notNull()
			.references(() => signerTokens.id, { onDelete: "cascade" }),
		status: text("status").notNull(),
		toEmail: text("to_email").notNull(),
		fromEmail: text("from_email").notNull(),
		replyToEmail: text("reply_to_email"),
		subject: text("subject").notNull(),
		textBody: text("text_body").notNull(),
		htmlBody: text("html_body").notNull(),
		verificationUrl: text("verification_url").notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("contract_invitation_outbox_recipient_unique").on(table.recipientId),
		index("contract_invitation_outbox_status_created_idx").on(table.status, table.createdAt),
	],
);
