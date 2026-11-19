import { type SQL, sql } from "drizzle-orm";
import { signingStatement } from "@/db/envelope/signing-batch";
import { getDb } from "@/db/setup";
import { sha256Hex } from "@/hono/api/envelope-route-helpers";
import {
	type ContractDefinition,
	type DraftContractRequest,
	type PatchContractRequest,
	parseDraftContract,
	prepareDraftContract,
	requestWithPdf,
} from "./contracts-draft-schema";
import {
	type ContractCommand,
	commandReceipt,
	contractAudit,
	type DraftSnapshot,
	getDraftSnapshot,
	guardedContractBatch,
	requireDraft,
} from "./contracts-draft-store";
import { ContractError, type ContractSummary } from "./contracts-schema";

type PreparedDraft = Awaited<ReturnType<typeof prepareDraftContract>>;
export type StoredContractSummary = ContractSummary & { definition: ContractDefinition };
export type DraftWriteInput = ContractCommand & {
	documentsBucket: R2Bucket;
	request: DraftContractRequest;
};

export async function createClaimedContractDraft(
	input: DraftWriteInput,
): Promise<StoredContractSummary> {
	const prepared = await prepareDraftContract(input.request);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const sourceKey = `envelopes/${id}/source-${crypto.randomUUID()}.pdf`;
	await getDb().batch([
		signingStatement(
			sql`select 1/case when exists(select 1 from agentic_command_records where id=${input.recordId} and state='pending' and document_id is null for update) then 1 else 0 end as guard`,
		),
		signingStatement(
			sql`insert into envelopes(id,created_by,status,created_at) values(${id},${input.email.trim().toLowerCase()},'draft',${now})`,
		),
		signingStatement(registerArtifact(id, sourceKey)),
		signingStatement(
			sql`update agentic_command_records set document_id=${id} where id=${input.recordId} and state='pending'`,
		),
	]);
	const snapshot: DraftSnapshot = {
		id,
		status: "draft",
		createdAt: now,
		sourceId: null,
		sourceKey: null,
		sourceVersion: 0,
		definitionId: null,
		definition: null,
		recipients: [],
		deleting: false,
	};
	return uploadAndSave(input, snapshot, prepared, sourceKey, 201);
}

export async function replaceClaimedContractPdf(
	input: DraftWriteInput & { id: string },
): Promise<StoredContractSummary> {
	const sourceKey = `envelopes/${input.id}/source-${crypto.randomUUID()}.pdf`;
	const prepared = await prepareDraftContract(input.request);
	const snapshot = await getDraftSnapshot(input.email, input.id, {
		recordId: input.recordId,
		sourceKey,
	});
	return uploadAndSave(input, snapshot, prepared, sourceKey, 200);
}

async function uploadAndSave(
	input: DraftWriteInput,
	snapshot: DraftSnapshot,
	prepared: PreparedDraft,
	sourceKey: string,
	status: number,
): Promise<StoredContractSummary> {
	let uploaded = false;
	try {
		await input.documentsBucket.put(sourceKey, prepared.bytes, {
			httpMetadata: { contentType: "application/pdf" },
		});
		uploaded = true;
		const summary = summaryForDraft(snapshot, prepared.definition);
		await guardedContractBatch(input, snapshot, [
			...definitionWrites(snapshot.id, prepared),
			sql`insert into source_documents(id,envelope_id,r2_key,version,sha256,byte_size,content_type,original_filename,uploaded_by) values(${crypto.randomUUID()},${snapshot.id},${sourceKey},${snapshot.sourceVersion + 1},${await sha256Hex(prepared.bytes)},${prepared.bytes.byteLength},'application/pdf',${prepared.definition.pdf.filename},${input.email.trim().toLowerCase()})`,
			contractAudit(snapshot.id, "source_pdf.uploaded", input.email.trim().toLowerCase()),
			commandReceipt(input.recordId, snapshot.id, { data: summary }, status),
		]);
		return summary;
	} catch (error) {
		// Unique immutable locator: cleanup cannot erase a different successful replacement.
		// A missing database receipt can follow a committed source/response transaction.
		// Keep uploaded artifacts in the manifest, including rolled-back reservations, until deletion.
		if (!uploaded) {
			try {
				await input.documentsBucket.delete(sourceKey);
			} catch {
				/* The durable manifest retains uncertain artifacts for deletion. */
			}
		}
		if (!uploaded)
			throw new ContractError("STORAGE_UNAVAILABLE", "The source PDF could not be stored", 503);
		throw error;
	}
}

export async function patchClaimedContractDraft(
	input: ContractCommand & { id: string; patch: PatchContractRequest; documentsBucket: R2Bucket },
): Promise<StoredContractSummary> {
	const snapshot = await getDraftSnapshot(input.email, input.id);
	requireDraft(snapshot);
	if (!snapshot.definition || !snapshot.sourceKey)
		throw new ContractError(
			"SOURCE_PDF_UNAVAILABLE",
			"Replace the PDF and definitions before editing this draft",
			503,
		);
	const object = await input.documentsBucket.get(snapshot.sourceKey);
	if (!object)
		throw new ContractError(
			"SOURCE_PDF_UNAVAILABLE",
			"The source PDF is temporarily unavailable",
			503,
		);
	const request = requestWithPdf(snapshot.definition, new Uint8Array(await object.arrayBuffer()));
	// Parsing the full merged definition validates recipient references and field placement together.
	const prepared = await prepareDraftContract(parseDraftContract({ ...request, ...input.patch }));
	const summary = summaryForDraft(snapshot, prepared.definition);
	await guardedContractBatch(input, snapshot, [
		...definitionWrites(input.id, prepared),
		commandReceipt(input.recordId, input.id, { data: summary }, 200),
	]);
	return summary;
}

function registerArtifact(id: string, sourceKey: string): SQL {
	return sql`insert into envelope_artifact_versions(id,envelope_id,r2_key) values(${crypto.randomUUID()},${id},${sourceKey})`;
}

function definitionWrites(id: string, prepared: PreparedDraft): SQL[] {
	const now = Date.now();
	const recipients = prepared.recipients.map((recipient, index) => ({
		...recipient,
		id: crypto.randomUUID(),
		created_at: new Date(now + index).toISOString(),
	}));
	const fields = prepared.fields.map((field) => {
		const recipient = recipients.find((person) => person.index === field.recipient);
		if (!recipient)
			throw new ContractError("INVALID_FIELDS", "A field references an unknown recipient");
		return { ...field, id: crypto.randomUUID(), recipient_id: recipient.id };
	});
	return [
		// Drafts never have active links or completed values. Replacements retain their immutable file manifest.
		sql`select 1 / case when not exists(select 1 from field_values where envelope_id=${id}) and not exists(select 1 from audit_events where envelope_id=${id} and recipient_id is not null) then 1 else 0 end as guard`,
		sql`delete from contract_invitation_outbox where envelope_id=${id}`,
		sql`delete from email_send_records where envelope_id=${id}`,
		sql`delete from signer_tokens where envelope_id=${id}`,
		sql`delete from envelope_fields where envelope_id=${id}`,
		sql`delete from envelope_recipients where envelope_id=${id}`,
		sql`insert into envelope_recipients(id,envelope_id,name,email,status,created_at) select r.id,${id},r.name,r.email,'pending',r.created_at from jsonb_to_recordset(${JSON.stringify(recipients)}::jsonb) as r(id uuid,name text,email text,created_at timestamptz)`,
		sql`insert into envelope_fields(id,envelope_id,recipient_id,type,name,label,required,is_placeholder,page,x,y,width,height) select f.id,${id},f.recipient_id,f.type,f.name,f.label,f.required,f."isPlaceholder",f.page,f.x,f.y,f.width,f.height from jsonb_to_recordset(${JSON.stringify(fields)}::jsonb) as f(id uuid,recipient_id uuid,type text,name text,label text,required boolean,"isPlaceholder" boolean,page integer,x integer,y integer,width integer,height integer)`,
		contractAudit(id, "contract.definition", JSON.stringify(prepared.definition)),
		contractAudit(id, "contract.created", prepared.definition.title),
	];
}

export function summaryForDraft(
	snapshot: DraftSnapshot,
	definition: ContractDefinition,
): StoredContractSummary {
	const recipients = "recipients" in definition ? definition.recipients : [definition.recipient];
	return {
		id: snapshot.id,
		title: definition.title,
		status: "draft",
		recipients: recipients.map(({ name, email }) => ({ name, email, status: "pending" })),
		createdAt: new Date(snapshot.createdAt).toISOString(),
		completedAt: null,
		downloadUrl: null,
		definition,
	};
}
