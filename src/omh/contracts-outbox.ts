import { createTransactionalMailClient } from "@ohmyhost/customer-runtime/mail";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { noEnvelopeDeletion, signingStatement } from "@/db/envelope/signing-batch";
import { getDb } from "@/db/setup";
import type { OmhMailEnv } from "./mail";

const OutboxClaimSchema = z.object({
	status: z.enum(["sending", "manual_review"]),
	id: z.uuid(),
	envelope_id: z.uuid(),
	recipient_id: z.uuid(),
	token_id: z.uuid(),
	to_email: z.string(),
	from_email: z.string(),
	reply_to_email: z.string().nullable(),
	subject: z.string(),
	text_body: z.string(),
	html_body: z.string(),
	verification_url: z.string(),
});
type OutboxClaim = z.infer<typeof OutboxClaimSchema>;

/** At most three sequential jobs: each uses exactly one claim, mail call and receipt. */
export async function processContractInvitations(env: OmhMailEnv): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const job = await claimInvitation();
		if (!job) return;
		if (job.status === "manual_review") continue;
		try {
			await sendInvitation(env, job);
			await recordDelivered(job);
		} catch {
			// Delivery can have happened before an exception or failed receipt; never issue a new key.
			await getDb().execute(sql`update contract_invitation_outbox set status = 'uncertain', updated_at = now()
				where id = ${job.id} and status = 'sending'`);
			return;
		}
	}
}

async function claimInvitation(): Promise<OutboxClaim | null> {
	const rows = await getDb().execute(sql`
		update contract_invitation_outbox as job set status = case when job.first_attempt_at <= now() - interval '22 hours' then 'manual_review' else 'sending' end, claimed_at = now(),
			first_attempt_at = coalesce(first_attempt_at, now()), updated_at = now()
		where job.id = (
			select candidate.id from contract_invitation_outbox candidate
			join envelopes envelope on envelope.id = candidate.envelope_id
			where candidate.status = 'queued' and envelope.status = 'queued'
				and ${noEnvelopeDeletion(sql`candidate.envelope_id`)}
			order by candidate.created_at, candidate.id
			for update of candidate skip locked limit 1
		)
		returning job.status, job.id, job.envelope_id, job.recipient_id, job.token_id, job.to_email,
			job.from_email, job.reply_to_email, job.subject, job.text_body, job.html_body, job.verification_url`);
	return rows[0] ? OutboxClaimSchema.parse(rows[0]) : null;
}

async function sendInvitation(env: OmhMailEnv, job: OutboxClaim) {
	if (!env.OHMYHOST_MAIL_GATEWAY_URL || !env.OHMYHOST_MAIL_KEY || !env.OHMYHOST_PROJECT_ID)
		throw new Error("Mail gateway is unavailable");
	const client = createTransactionalMailClient({
		endpoint: env.OHMYHOST_MAIL_GATEWAY_URL,
		key: env.OHMYHOST_MAIL_KEY,
		projectId: env.OHMYHOST_PROJECT_ID,
		fetch: (request) => fetch(request),
	});
	const result = await client.send({
		from: job.from_email,
		...(job.reply_to_email ? { replyTo: job.reply_to_email } : {}),
		to: job.to_email,
		subject: job.subject,
		text: job.text_body,
		html: job.html_body,
		idempotencyKey: `sign.invitation.${job.id}`,
	});
	if (result.state !== "accepted") throw new Error("Mail delivery is uncertain");
}

async function recordDelivered(job: OutboxClaim): Promise<void> {
	const envelopeId = job.envelope_id;
	await getDb().batch([
		// Lock the envelope first so concurrent receipts cannot both miss the final transition.
		signingStatement(sql`select 1 / case when exists (
			select 1 from envelopes e join contract_invitation_outbox j on j.envelope_id = e.id
			where e.id = ${envelopeId} and e.status = 'queued' and j.id = ${job.id}
			and j.status = 'sending' and ${noEnvelopeDeletion(sql`e.id`)}
			for update of e, j
		) then 1 else 0 end as guard`),
		signingStatement(sql`update contract_invitation_outbox set status = 'delivered', updated_at = now()
			where id = ${job.id} and status = 'sending'`),
		signingStatement(sql`insert into email_send_records (id, envelope_id, recipient_id, token_id, email, kind, fallback_url, sent_at)
			values (${crypto.randomUUID()}, ${envelopeId}, ${job.recipient_id}, ${job.token_id}, ${job.to_email},
			'partner_verification', ${new URL(job.verification_url).pathname}, now())`),
		signingStatement(sql`insert into audit_events (id, envelope_id, recipient_id, event_type, message, created_at)
			values (${crypto.randomUUID()}, ${envelopeId}, ${job.recipient_id}, 'partner.verification.sent', ${job.to_email}, now())`),
		signingStatement(sql`update envelope_recipients set status = 'sent' where envelope_id = ${envelopeId}
			and not exists (select 1 from contract_invitation_outbox where envelope_id = ${envelopeId} and status <> 'delivered')`),
		signingStatement(sql`update signer_tokens set status = 'active', expires_at = now() + interval '7 days'
			where envelope_id = ${envelopeId} and status = 'revoked'
			and not exists (select 1 from contract_invitation_outbox where envelope_id = ${envelopeId} and status <> 'delivered')`),
		signingStatement(sql`update envelopes set status = 'sent', sent_by = created_by, sent_at = now()
			where id = ${envelopeId} and status = 'queued'
			and not exists (select 1 from contract_invitation_outbox where envelope_id = ${envelopeId} and status <> 'delivered')`),
		signingStatement(sql`insert into audit_events (id, envelope_id, recipient_id, event_type, message, created_at)
			select ${crypto.randomUUID()}, id, null, 'envelope.sent', created_by, now() from envelopes
			where id = ${envelopeId} and status = 'sent' and not exists (
				select 1 from audit_events a where a.envelope_id = ${envelopeId} and a.event_type = 'envelope.sent')`),
	]);
}

/** The gateway retains idempotency evidence for 23h; stop replay conservatively after 22h. */
export async function retryContractInvitations(
	envelopeId: string,
	owner: string,
): Promise<{ requeued: number; manualReview: number }> {
	const rows = await getDb().execute(sql`update contract_invitation_outbox job set
		status = case when job.first_attempt_at <= now() - interval '22 hours' then 'manual_review' else 'queued' end,
		claimed_at = null, updated_at = now()
		where job.envelope_id = ${envelopeId} and (
			job.status = 'uncertain' or (job.status = 'sending' and job.claimed_at < now() - interval '10 minutes')
		) and exists (select 1 from envelopes e where e.id = job.envelope_id
			and e.created_by = ${owner.trim().toLowerCase()} and e.status = 'queued'
			and ${noEnvelopeDeletion(sql`e.id`)}) returning job.status`);
	return {
		requeued: rows.filter((row) => row.status === "queued").length,
		manualReview: rows.filter((row) => row.status === "manual_review").length,
	};
}
