import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { envelopes, finalDocuments } from "@/db/envelope/table";

/** One immutable final-version delivery intent per normalized participant address. */
export const contractFinalDeliveryOutbox = pgTable(
	"contract_final_delivery_outbox",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		envelopeId: uuid("envelope_id")
			.notNull()
			.references(() => envelopes.id, { onDelete: "cascade" }),
		finalDocumentId: uuid("final_document_id")
			.notNull()
			.references(() => finalDocuments.id, { onDelete: "cascade" }),
		finalSha256: text("final_sha256").notNull(),
		toEmail: text("to_email").notNull(),
		accessPath: text("access_path").notNull(),
		status: text("status").notNull().default("queued"),
		fromEmail: text("from_email"),
		replyToEmail: text("reply_to_email"),
		accessUrl: text("access_url"),
		subject: text("subject"),
		textBody: text("text_body"),
		htmlBody: text("html_body"),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("contract_final_delivery_version_email_unique").on(
			table.finalDocumentId,
			table.finalSha256,
			table.toEmail,
		),
		index("contract_final_delivery_status_created_idx").on(table.status, table.createdAt),
	],
);
