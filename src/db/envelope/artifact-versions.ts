import { eq } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { getDb } from "@/db/setup";
import { envelopes } from "./table";

/** Retain every immutable final locator until the envelope's files are erased. */
export const envelopeArtifactVersions = pgTable("envelope_artifact_versions", {
	id: uuid("id").defaultRandom().primaryKey(),
	envelopeId: uuid("envelope_id")
		.notNull()
		.references(() => envelopes.id),
	r2Key: text("r2_key").notNull().unique(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export async function recordArtifactVersion(envelopeId: string, r2Key: string): Promise<void> {
	try {
		await getDb().insert(envelopeArtifactVersions).values({ envelopeId, r2Key }).returning();
	} catch (error) {
		// The same successful upload is recorded again when an uncertain finalization
		// is retried. The unique locator makes that retry harmless.
		if (!isUniqueViolation(error)) throw error;
	}
}

export async function getArtifactVersionKeys(envelopeId: string): Promise<string[]> {
	const rows = await getDb()
		.select()
		.from(envelopeArtifactVersions)
		.where(eq(envelopeArtifactVersions.envelopeId, envelopeId))
		.limit(4001);
	if (rows.length > 4000)
		throw new Error("Document has too many stored versions for one deletion request");
	return rows.map((row) => row.r2Key);
}

function isUniqueViolation(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if ("code" in error && error.code === "23505") return true;
	return "cause" in error && error.cause !== error && isUniqueViolation(error.cause);
}
