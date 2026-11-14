import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { agenticCommandRecords } from "@/db/agentic-access/table";
import {
	isSigningGuardFailure,
	noEnvelopeDeletion,
	signingStatement,
} from "@/db/envelope/signing-batch";
import { getDb } from "@/db/setup";
import type { ContractDefinition } from "./contracts-draft-schema";
import { ContractError } from "./contracts-schema";

export interface ContractCommand {
	recordId: string;
	email: string;
}
export interface DraftSnapshot {
	id: string;
	status: string;
	createdAt: string;
	sourceId: string | null;
	sourceKey: string | null;
	sourceVersion: number;
	definitionId: string | null;
	definition: ContractDefinition | null;
	deleting: boolean;
	recipients: Array<{ id: string; name: string; email: string; status: string }>;
}
const SnapshotSchema = z.object({
	id: z.uuid(),
	status: z.string(),
	createdAt: z.string(),
	sourceId: z.uuid().nullable(),
	sourceKey: z.string().nullable(),
	sourceVersion: z.number(),
	definitionId: z.uuid().nullable(),
	definition: z.record(z.string(), z.unknown()).nullable(),
	deleting: z.boolean(),
	recipients: z.array(
		z.object({ id: z.uuid(), name: z.string(), email: z.string(), status: z.string() }),
	),
});

export async function getDraftSnapshot(
	email: string,
	id: string,
	reservation?: { recordId: string; sourceKey: string },
): Promise<DraftSnapshot> {
	const query = sql`select e.id, e.status, e.created_at::text as "createdAt",
		${artifactCount(sql`e.id`)} as "artifactCount",
		s.id as "sourceId", s.r2_key as "sourceKey", coalesce(s.version,0) as "sourceVersion",
		d.id as "definitionId", coalesce(d.message::jsonb,case when
			(select count(*) from envelope_recipients r where r.envelope_id=e.id)=1
			and exists(select 1 from envelope_fields f where f.envelope_id=e.id)
			and not exists(select 1 from envelope_fields f where f.envelope_id=e.id and f.is_placeholder is true)
			then jsonb_build_object('title',coalesce((select message from audit_events where envelope_id=e.id and event_type='contract.created' order by created_at desc,id desc limit 1),s.original_filename,'Untitled contract'),
			'pdf',jsonb_build_object('filename',s.original_filename),
			'recipient',(select jsonb_build_object('name',r.name,'email',r.email) from envelope_recipients r where r.envelope_id=e.id limit 1),
			'fields',(select jsonb_agg(jsonb_build_object('type',f.type,'page',f.page,'x',f.x,'y',f.y,'width',f.width,'height',f.height) order by f.created_at,f.id) from envelope_fields f where f.envelope_id=e.id)) else null end) as definition,
		not (${noEnvelopeDeletion(sql`e.id`)}) as deleting,
		coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'email',r.email,'status',r.status) order by r.created_at,r.id) from envelope_recipients r where r.envelope_id=e.id),'[]'::jsonb) as recipients
		from envelopes e left join lateral (select id,r2_key,version,original_filename from source_documents where envelope_id=e.id order by version desc,id desc limit 1) s on true
		left join lateral (select id,message from audit_events where envelope_id=e.id and event_type='contract.definition' order by created_at desc,id desc limit 1) d on true
		where e.id=${id} and e.created_by=${email.trim().toLowerCase()} and e.status<>'deleted' limit 1`;
	let rows: Record<string, unknown>[];
	let reserved = true;
	if (reservation) {
		const result = await getDb().batch([
			signingStatement(sql`select id from envelopes where id=${id} for update`),
			signingStatement(sql`insert into envelope_artifact_versions(id,envelope_id,r2_key)
			 select ${crypto.randomUUID()},e.id,${reservation.sourceKey} from envelopes e
			 where e.id=${id} and e.created_by=${email.trim().toLowerCase()} and e.status='draft'
			 and ${noEnvelopeDeletion(sql`e.id`)} and ${artifactCount(sql`e.id`)}<4000
			 and exists(select 1 from agentic_command_records c where c.id=${reservation.recordId} and c.state='pending' and (c.document_id is null or c.document_id=e.id)) returning r2_key`),
			signingStatement(
				sql`update agentic_command_records set document_id=${id} where id=${reservation.recordId} and state='pending' and exists(select 1 from envelope_artifact_versions where r2_key=${reservation.sourceKey})`,
			),
			signingStatement(query),
		]);
		rows = [...(result.at(-1)?.rows ?? [])];
		reserved = (result[1]?.rows.length ?? 0) > 0;
	} else rows = await getDb().execute(query);
	if (!rows[0]) throw new ContractError("CONTRACT_NOT_FOUND", "Contract not found", 404);
	const snapshot = SnapshotSchema.parse(rows[0]) as DraftSnapshot;
	if (reservation) {
		requireDraft(snapshot);
		if (!reserved && Number(rows[0].artifactCount) >= 4000)
			throw new ContractError(
				"SOURCE_VERSION_LIMIT",
				"A draft can retain at most 4000 PDF artifacts; delete it and create a new draft",
				413,
			);
		if (!reserved)
			throw new ContractError(
				"CONTRACT_CHANGED",
				"The contract changed; reload before retrying",
				409,
			);
	}
	return snapshot;
}

function artifactCount(id: SQL): SQL {
	return sql`(select count(*)::integer from (select r2_key from envelope_artifact_versions where envelope_id=${id} union select r2_key from source_documents where envelope_id=${id} union select r2_key from final_documents where envelope_id=${id}) as stored_artifacts)`;
}

export function requireDraft(snapshot: DraftSnapshot, allowDeletion = false): void {
	if (snapshot.status !== "draft" || (snapshot.deleting && !allowDeletion))
		throw new ContractError(
			"CONTRACT_NOT_DRAFT",
			"Only an active draft can be changed or sent",
			409,
		);
}

function contractGuard(
	input: ContractCommand,
	snapshot: DraftSnapshot,
	options: { allowDeletion?: boolean; statuses?: string[] } = {},
): SQL {
	return sql`select 1 / case when exists(select 1 from envelopes e join agentic_command_records c on c.id=${input.recordId}
		where e.id=${snapshot.id} and e.created_by=${input.email.trim().toLowerCase()}
		and e.status in (${sql.join(
			(options.statuses ?? ["draft"]).map((status) => sql`${status}`),
			sql`,`,
		)})
		and c.state='pending' and (c.document_id is null or c.document_id=e.id)
		${options.allowDeletion ? sql`` : sql`and ${noEnvelopeDeletion(sql`e.id`)}`}
		and (select a.id from audit_events a where a.envelope_id=e.id and a.event_type='contract.definition' order by a.created_at desc,a.id desc limit 1) is not distinct from ${snapshot.definitionId}::uuid
		and (select s.id from source_documents s where s.envelope_id=e.id order by s.version desc,s.id desc limit 1) is not distinct from ${snapshot.sourceId}::uuid)
		then 1 else 0 end as guard`;
}

export async function guardedContractBatch(
	input: ContractCommand,
	snapshot: DraftSnapshot,
	operations: SQL[],
	options?: { allowDeletion?: boolean; statuses?: string[] },
) {
	try {
		return await getDb().batch([
			signingStatement(sql`select id from envelopes where id=${snapshot.id} for update`),
			signingStatement(contractGuard(input, snapshot, options)),
			...operations.map(signingStatement),
		]);
	} catch (error) {
		if (isSigningGuardFailure(error))
			throw new ContractError(
				"CONTRACT_CHANGED",
				"The contract changed; reload before retrying",
				409,
			);
		throw error;
	}
}

export function commandReceipt(recordId: string, id: string, body: unknown, status: number): SQL {
	return sql`update ${agenticCommandRecords} set state='completed',document_id=${id},response_status=${status},response_body=${JSON.stringify(body)},completed_at=now() where id=${recordId} and state='pending'`;
}

export function contractAudit(id: string, type: string, message: string | null): SQL {
	return sql`insert into audit_events(id,envelope_id,event_type,message,created_at) values(${crypto.randomUUID()},${id},${type},${message},clock_timestamp())`;
}
