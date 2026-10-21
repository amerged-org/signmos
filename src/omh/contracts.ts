import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
	auditEvents,
	envelopeRecipients,
	envelopes,
	finalDocuments,
	sourceDocuments,
} from "@/db/envelope";
import { getDb } from "@/db/setup";
import type { ContractSummary } from "./contracts-schema";

export async function listContracts(email: string): Promise<ContractSummary[]> {
	const rows = await getDb()
		.select(contractSelection)
		.from(envelopes)
		.where(
			and(eq(envelopes.createdBy, email.trim().toLowerCase()), ne(envelopes.status, "deleted")),
		)
		.orderBy(desc(envelopes.createdAt), desc(envelopes.id))
		.limit(100);
	return rows.map(toContractSummary);
}

export async function getContract(email: string, id: string): Promise<ContractSummary | null> {
	const rows = await getDb()
		.select(contractSelection)
		.from(envelopes)
		.where(
			and(
				eq(envelopes.id, id),
				eq(envelopes.createdBy, email.trim().toLowerCase()),
				ne(envelopes.status, "deleted"),
			),
		)
		.limit(1);
	return rows[0] ? toContractSummary(rows[0]) : null;
}

type ContractPdfLookup =
	| { state: "not_found" | "not_completed" | "unavailable" }
	| { state: "ready"; r2Key: string };

export async function getContractFinalPdf(email: string, id: string): Promise<ContractPdfLookup> {
	const rows = await getDb()
		.select({ status: envelopes.status, r2Key: latestFinalKey })
		.from(envelopes)
		.where(
			and(
				eq(envelopes.id, id),
				eq(envelopes.createdBy, email.trim().toLowerCase()),
				ne(envelopes.status, "deleted"),
				sql`not ${deletionIntent}`,
			),
		)
		.limit(1);
	const row = rows[0];
	if (!row) return { state: "not_found" };
	if (row.status !== "completed") return { state: "not_completed" };
	return row.r2Key ? { state: "ready", r2Key: row.r2Key } : { state: "unavailable" };
}

// Correlated projections retain one row per owned envelope without multiplying recipients,
// source versions and audit rows, and make a catalog/detail read one private database RPC.
// Drizzle removes Column qualifiers inside a single-table selection; retain the outer scope
// as explicit trusted identifiers so inner document IDs cannot shadow the envelope ID.
const envelopeReference = sql`${sql.identifier("envelopes")}.${sql.identifier("id")}`;
const deletionIntent = sql`exists(select 1 from ${auditEvents} as ${sql.identifier("contract_deletion")}
 where ${sql.identifier("contract_deletion")}.${sql.identifier("envelope_id")}=${envelopeReference}
 and ${sql.identifier("contract_deletion")}.${sql.identifier("event_type")}=${"envelope.deletion_started"})`;
const latestFinalKey = sql<string | null>`(select ${finalDocuments.r2Key} from ${finalDocuments}
 where ${finalDocuments.envelopeId}=${envelopeReference}
 order by ${finalDocuments.createdAt} desc,${finalDocuments.id} desc limit 1)`;
const contractSelection = {
	id: envelopes.id,
	status: envelopes.status,
	createdAt: envelopes.createdAt,
	recipients: sql<ContractSummary["recipients"]>`coalesce((select jsonb_agg(jsonb_build_object(
  'name',${envelopeRecipients.name},'email',${envelopeRecipients.email},'status',${envelopeRecipients.status})
  order by ${envelopeRecipients.createdAt},${envelopeRecipients.id}) from ${envelopeRecipients}
  where ${envelopeRecipients.envelopeId}=${envelopeReference}),'[]'::jsonb)`,
	sourceFilename: sql<
		string | null
	>`(select ${sourceDocuments.originalFilename} from ${sourceDocuments}
  where ${sourceDocuments.envelopeId}=${envelopeReference} order by ${sourceDocuments.version} desc,${sourceDocuments.id} desc limit 1)`,
	finalCreatedAt: sql<
		string | null
	>`case when ${deletionIntent} then null else (select ${finalDocuments.createdAt}::text from ${finalDocuments}
  where ${finalDocuments.envelopeId}=${envelopeReference} order by ${finalDocuments.createdAt} desc,${finalDocuments.id} desc limit 1) end`,
	title: sql<string | null>`(select ${auditEvents.message} from ${auditEvents}
  where ${auditEvents.envelopeId}=${envelopeReference} and ${auditEvents.eventType}=${"contract.created"}
  order by ${auditEvents.createdAt} desc,${auditEvents.id} desc limit 1)`,
};

function toContractSummary(row: {
	id: string;
	status: string;
	createdAt: Date;
	recipients: ContractSummary["recipients"];
	sourceFilename: string | null;
	finalCreatedAt: string | null;
	title: string | null;
}): ContractSummary {
	const completedAt =
		row.status === "completed" && row.finalCreatedAt
			? new Date(row.finalCreatedAt).toISOString()
			: null;
	return {
		id: row.id,
		title: row.title ?? row.sourceFilename?.replace(/\.pdf$/i, "") ?? "Untitled contract",
		status: row.status,
		recipients: row.recipients,
		createdAt: row.createdAt.toISOString(),
		completedAt,
		downloadUrl: completedAt ? `/api/contracts/${row.id}/pdf` : null,
	};
}
