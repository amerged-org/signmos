import { sql } from "drizzle-orm";
import { noEnvelopeDeletion, signingStatement } from "@/db/envelope/signing-batch";

/** Runs after the final locator and completed status have been committed in the same batch. */
export function finalDeliveryIntent(documentId: string, sha256: string) {
	return signingStatement(sql`/* signing-final-delivery-intent */
 insert into contract_final_delivery_outbox (envelope_id, final_document_id, final_sha256, to_email, access_path)
 select f.envelope_id, f.id, f.sha256, party.email, party.access_path
 from final_documents f join envelopes e on e.id = f.envelope_id
 cross join lateral (
  select distinct on (email) email, access_path from (
   select lower(trim(e.created_by)) as email, '/my-documents/' || e.id::text as access_path, 0 as priority
   union all
   select lower(trim(r.email)), coalesce('/completed-documents/' || (
    select t.token from signer_tokens t where t.recipient_id = r.id and t.envelope_id = e.id and t.status = 'active'
    order by t.created_at desc, t.id desc limit 1
   ), '/my-documents/' || e.id::text), 1
   from envelope_recipients r where r.envelope_id = e.id
  ) participants order by email, priority, access_path
 ) party
 where f.id = ${documentId} and f.sha256 = ${sha256} and e.status = 'completed' and ${noEnvelopeDeletion(sql`e.id`)}
 and not exists (select 1 from envelope_recipients r where r.envelope_id = e.id and r.status <> 'completed')
 on conflict (final_document_id, final_sha256, to_email) do nothing`);
}

/** The final link gets its own usable window even when an earlier party signed days ago. */
export function refreshFinalDeliveryLinks(documentId: string) {
	return signingStatement(sql`/* signing-final-delivery-expiry */ update signer_tokens t
 set expires_at = greatest(t.expires_at, now() + interval '7 days')
 where t.status = 'active' and exists (
  select 1 from contract_final_delivery_outbox job where job.final_document_id = ${documentId}
  and job.envelope_id = t.envelope_id and job.status = 'queued' and job.first_attempt_at is null
 )`);
}
