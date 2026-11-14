import { sql } from "drizzle-orm";
import {
	buildPartnerVerificationEmail,
	type EmailDeliveryOptions,
	isResendConfigured,
	toAbsoluteDeliveryUrl,
} from "@/db/envelope/email-delivery";
import {
	type ContractCommand,
	commandReceipt,
	contractAudit,
	getDraftSnapshot,
	guardedContractBatch,
	requireDraft,
} from "./contracts-draft-store";
import { type StoredContractSummary, summaryForDraft } from "./contracts-drafts";
import { ContractError } from "./contracts-schema";

interface ContractSigningLink {
	recipientId: string;
	email: string;
	url: string;
	expiresAt: string;
}
export type SentContract = Omit<StoredContractSummary, "definition"> & {
	signingLinks: ContractSigningLink[];
};

export async function sendClaimedContract(
	input: ContractCommand & {
		id: string;
		delivery: "email" | "manual";
		emailDelivery: EmailDeliveryOptions;
	},
): Promise<SentContract> {
	const snapshot = await getDraftSnapshot(input.email, input.id);
	requireDraft(snapshot);
	if (!snapshot.definition || !snapshot.sourceKey || snapshot.recipients.length === 0)
		throw new ContractError(
			"SOURCE_PDF_UNAVAILABLE",
			"Replace the PDF and definitions before sending this draft",
			503,
		);
	if (input.delivery === "email" && !isResendConfigured(input.emailDelivery.env ?? {}))
		throw new ContractError("EMAIL_UNAVAILABLE", "Email delivery is not configured", 503);
	const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
	const recipients = snapshot.recipients.map((recipient) => ({
		...recipient,
		tokenId: crypto.randomUUID(),
		token: crypto.randomUUID(),
		expiresAt,
	}));
	const status = input.delivery === "manual" ? "sent" : "queued";
	const { definition: _definition, ...summary } = summaryForDraft(snapshot, snapshot.definition);
	const contract: SentContract = {
		...summary,
		status,
		recipients: summary.recipients.map((recipient) => ({
			...recipient,
			status: input.delivery === "manual" ? "sent" : "pending",
		})),
		signingLinks: recipients.map((recipient) => ({
			recipientId: recipient.id,
			email: recipient.email,
			url: toAbsoluteDeliveryUrl(`/signing-verifications/${recipient.token}`, input.emailDelivery),
			expiresAt,
		})),
	};
	const tokenRows = recipients.map((recipient) => ({
		id: recipient.tokenId,
		recipient_id: recipient.id,
		token: recipient.token,
		expires_at: expiresAt,
	}));
	const jobs = recipients.map((recipient) => {
		const verificationUrl = toAbsoluteDeliveryUrl(
			`/signing-verifications/${recipient.token}`,
			input.emailDelivery,
		);
		const mail = buildPartnerVerificationEmail({
			email: recipient.email,
			recipientName: recipient.name,
			verificationUrl,
		});
		return {
			id: crypto.randomUUID(),
			recipient_id: recipient.id,
			token_id: recipient.tokenId,
			to_email: mail.to,
			from_email:
				input.emailDelivery.env?.SIGN_FROM_EMAIL ??
				input.emailDelivery.env?.RESEND_FROM_EMAIL ??
				"",
			reply_to_email:
				input.emailDelivery.env?.SIGN_REPLY_TO_EMAIL ??
				input.emailDelivery.env?.RESEND_REPLY_TO_EMAIL ??
				null,
			subject: mail.subject,
			text_body: mail.text,
			html_body: mail.html,
			verification_url: verificationUrl,
		};
	});
	await guardedContractBatch(input, snapshot, [
		sql`select 1 / case when exists(select 1 from envelope_fields where envelope_id=${input.id}) and not exists(select 1 from envelope_recipients r where r.envelope_id=${input.id} and not exists(select 1 from envelope_fields f where f.recipient_id=r.id)) then 1 else 0 end as guard`,
		sql`insert into signer_tokens(id,envelope_id,recipient_id,token,status,expires_at) select t.id,${input.id},t.recipient_id,t.token,${input.delivery === "manual" ? "active" : "revoked"},t.expires_at from jsonb_to_recordset(${JSON.stringify(tokenRows)}::jsonb) as t(id uuid,recipient_id uuid,token text,expires_at timestamptz)`,
		...(input.delivery === "email"
			? [
					sql`insert into contract_invitation_outbox(id,envelope_id,recipient_id,token_id,status,to_email,from_email,reply_to_email,subject,text_body,html_body,verification_url) select j.id,${input.id},j.recipient_id,j.token_id,'queued',j.to_email,j.from_email,j.reply_to_email,j.subject,j.text_body,j.html_body,j.verification_url from jsonb_to_recordset(${JSON.stringify(jobs)}::jsonb) as j(id uuid,recipient_id uuid,token_id uuid,to_email text,from_email text,reply_to_email text,subject text,text_body text,html_body text,verification_url text)`,
				]
			: []),
		sql`update envelope_recipients set status=${input.delivery === "manual" ? "sent" : "pending"} where envelope_id=${input.id}`,
		sql`update envelopes set status=${status},sent_by=${input.email.trim().toLowerCase()},sent_at=${input.delivery === "manual" ? new Date().toISOString() : null}::timestamptz where id=${input.id}`,
		contractAudit(
			input.id,
			input.delivery === "manual" ? "envelope.sent" : "envelope.send_queued",
			input.email.trim().toLowerCase(),
		),
		commandReceipt(
			input.recordId,
			input.id,
			{ data: contract },
			input.delivery === "manual" ? 200 : 202,
		),
	]);
	return contract;
}

export async function cancelClaimedContract(
	input: ContractCommand & { id: string },
): Promise<{ id: string; status: "expired" }> {
	const snapshot = await getDraftSnapshot(input.email, input.id);
	if (
		snapshot.deleting ||
		![
			"draft",
			"preparing",
			"queued",
			"sent",
			"changes_requested",
			"awaiting_verification",
			"expired",
		].includes(snapshot.status)
	)
		throw new ContractError(
			"CONTRACT_NOT_CANCELLABLE",
			"This contract can no longer be cancelled",
			409,
		);
	const result = { id: input.id, status: "expired" as const };
	await guardedContractBatch(
		input,
		snapshot,
		[
			sql`update envelopes set status='expired' where id=${input.id}`,
			sql`update signer_tokens set status='revoked' where envelope_id=${input.id}`,
			sql`update contract_invitation_outbox set status='cancelled',updated_at=now() where envelope_id=${input.id} and status<>'delivered'`,
			contractAudit(input.id, "envelope.cancelled", input.email.trim().toLowerCase()),
			commandReceipt(input.recordId, input.id, { data: result }, 200),
		],
		{ statuses: [snapshot.status] },
	);
	return result;
}

export async function deleteClaimedContractDraft(
	input: ContractCommand & { id: string; documentsBucket: R2Bucket },
): Promise<{ id: string; status: "deleted" }> {
	const snapshot = await getDraftSnapshot(input.email, input.id);
	requireDraft(snapshot, true);
	const batch = await guardedContractBatch(
		input,
		snapshot,
		[
			// A reservation spans the file upload; deletion must not inventory before it finishes.
			sql`select 1 / case when not exists(select 1 from agentic_command_records where document_id=${input.id} and state='pending' and id<>${input.recordId} and operation in ('contracts.drafts.create','contracts.pdf.replace')) then 1 else 0 end as guard`,
			sql`insert into audit_events(id,envelope_id,event_type,message) select ${crypto.randomUUID()},${input.id},'envelope.deletion_started',${input.email.trim().toLowerCase()} where not exists(select 1 from audit_events where envelope_id=${input.id} and event_type='envelope.deletion_started')`,
			sql`select r2_key from envelope_artifact_versions where envelope_id=${input.id} union select r2_key from source_documents where envelope_id=${input.id} union select r2_key from final_documents where envelope_id=${input.id} limit 4001`,
		],
		{ allowDeletion: true },
	);
	const keys = batch.at(-1)?.rows.map((row) => String(row.r2_key)) ?? [];
	if (keys.length > 4000)
		throw new ContractError(
			"TOO_MANY_ARTIFACTS",
			"Too many stored versions for one deletion request",
			413,
		);
	try {
		if (keys.length) await input.documentsBucket.delete(keys);
	} catch {
		throw new ContractError(
			"STORAGE_UNAVAILABLE",
			"Document erasure could not be confirmed; retry deletion with a new key",
			503,
		);
	}
	const result = { id: input.id, status: "deleted" as const };
	await guardedContractBatch(
		input,
		snapshot,
		[
			sql`update envelopes set status='deleted' where id=${input.id}`,
			sql`update signer_tokens set status='revoked' where envelope_id=${input.id}`,
			sql`update contract_invitation_outbox set status='cancelled',updated_at=now() where envelope_id=${input.id}`,
			contractAudit(input.id, "envelope.deleted", input.email.trim().toLowerCase()),
			commandReceipt(input.recordId, input.id, { data: result }, 200),
		],
		{ allowDeletion: true },
	);
	return result;
}
