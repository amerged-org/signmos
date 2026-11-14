import { eq, sql } from "drizzle-orm";
import {
	deliverTransactionalEmail,
	type EmailDeliveryOptions,
	isResendConfigured,
} from "@/db/envelope/email-delivery";
import { resolveSignerToken } from "@/db/envelope/signing";
import { signingStatement } from "@/db/envelope/signing-batch";
import { envelopeRecipients } from "@/db/envelope/table";
import { getDb } from "@/db/setup";
import { renderBrandedEmail } from "@/lib/branded-email";

export const signerEmailCookie = "signmos_signer_session";
export class SignerEmailError extends Error {
	constructor(
		readonly status: 400 | 404 | 410 | 429 | 503,
		readonly code: string,
		message: string,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
	}
}
export interface SignerEmailEnv {
	SIGN_OTP_SECRET?: string;
}
export async function hashSignerSession(value: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
export async function inspectSignerEmail(tokenValue: string, now = new Date()) {
	const token = await resolveSignerToken(tokenValue);
	if (!token) throw new SignerEmailError(404, "TOKEN_NOT_FOUND", "Signing token was not found");
	if (
		token.deletionPending ||
		["expired", "deleted", "declined"].includes(token.envelopeStatus) ||
		token.expiresAt <= now
	)
		throw new SignerEmailError(410, "EXPIRED_TOKEN", "This signing link is no longer active");
	const [recipient] = await getDb()
		.select()
		.from(envelopeRecipients)
		.where(eq(envelopeRecipients.id, token.recipientId))
		.limit(1);
	if (!recipient || recipient.envelopeId !== token.envelopeId)
		throw new SignerEmailError(404, "TOKEN_NOT_FOUND", "Signing token was not found");
	const email = recipient.email.trim().toLowerCase();
	return { token, email, emailHint: maskEmail(email) };
}
export async function requestSignerEmailCode(input: {
	token: string;
	now: Date;
	requestIp: string;
	env: SignerEmailEnv;
	emailDelivery: EmailDeliveryOptions;
}) {
	const secret = requireSecret(input.env);
	const identity = await inspectSignerEmail(input.token, input.now);
	if (!isResendConfigured(input.emailDelivery.env))
		throw new SignerEmailError(
			503,
			"EMAIL_DELIVERY_UNAVAILABLE",
			"Email delivery is not configured",
		);
	const challengeId = crypto.randomUUID();
	const code = randomCode();
	const codeHash = await hmac(
		secret,
		`${challengeId}:${identity.token.id}:${identity.email}:${code}`,
	);
	const recipientKey = `signer-email:recipient:${await hashSignerSession(identity.email)}`;
	const ipKey = `signer-email:ip:${await hashSignerSession(input.requestIp)}`;
	const cooldownKey = `signer-email:cooldown:${await hashSignerSession(identity.email)}`;
	const hour = new Date(input.now.getTime() + 3600000);
	const cooldown = new Date(input.now.getTime() + 60000);
	const expiresAt = new Date(input.now.getTime() + 600000);
	const statement = signingStatement(sql`with cooldown as (
  insert into rate_limit_records(key,operation,attempts,reset_at,updated_at) values(${cooldownKey},'signer-email-cooldown',1,${cooldown},${input.now})
  on conflict(key,operation) do update set reset_at=${cooldown},updated_at=${input.now} where rate_limit_records.reset_at<=${input.now} returning id
 ), recipient_limit as (
  insert into rate_limit_records(key,operation,attempts,reset_at,updated_at) select ${recipientKey},'signer-email-hour',1,${hour},${input.now} where exists(select 1 from cooldown)
  on conflict(key,operation) do update set attempts=case when rate_limit_records.reset_at<=${input.now} then 1 else rate_limit_records.attempts+1 end,
   reset_at=case when rate_limit_records.reset_at<=${input.now} then ${hour} else rate_limit_records.reset_at end,updated_at=${input.now} returning attempts,reset_at
 ), ip_limit as (
  insert into rate_limit_records(key,operation,attempts,reset_at,updated_at) select ${ipKey},'signer-email-hour',1,${hour},${input.now} where exists(select 1 from cooldown)
  on conflict(key,operation) do update set attempts=case when rate_limit_records.reset_at<=${input.now} then 1 else rate_limit_records.attempts+1 end,
   reset_at=case when rate_limit_records.reset_at<=${input.now} then ${hour} else rate_limit_records.reset_at end,updated_at=${input.now} returning attempts,reset_at
 ), issued as (
  insert into signer_email_challenges(id,token_id,email,code_hash,attempts,expires_at,created_at)
  select ${challengeId},${identity.token.id},${identity.email},${codeHash},0,${expiresAt},${input.now}
  where exists(select 1 from cooldown) and (select attempts from recipient_limit)<=5 and (select attempts from ip_limit)<=20
  on conflict(token_id) do update set id=excluded.id,email=excluded.email,code_hash=excluded.code_hash,attempts=0,expires_at=excluded.expires_at,consumed_at=null,created_at=excluded.created_at returning id
 ) select exists(select 1 from issued) as issued,
  case when (select attempts from recipient_limit)>5 or (select attempts from ip_limit)>20 then 3600 else 60 end as retry_after`);
	const [result] = await getDb().batch([statement]);
	if (!result?.rows[0]?.issued)
		throw new SignerEmailError(
			429,
			"EMAIL_CODE_RATE_LIMITED",
			"Please wait before requesting another code",
			Number(result?.rows[0]?.retry_after ?? 60),
		);
	try {
		await deliverTransactionalEmail(
			{
				to: identity.email,
				subject: "Dein Bestätigungscode · amerged Sign",
				text: `Dein Bestätigungscode: ${code}\n\nDer Code ist 10 Minuten gültig. Gib ihn nur in amerged Sign ein.`,
				html: renderBrandedEmail({
					eyebrow: "E-MAIL BESTÄTIGEN",
					title: "Dein Bestätigungscode",
					paragraphs: [
						`Dein Code: ${code}`,
						"Der Code ist 10 Minuten gültig. Gib ihn nur in amerged Sign ein.",
					],
					action: {
						label: "Code eingeben",
						url: new URL(
							`/signing-verifications/${input.token}`,
							input.emailDelivery.baseUrl,
						).toString(),
					},
				}),
			},
			input.emailDelivery,
		);
	} catch {
		throw new SignerEmailError(
			503,
			"EMAIL_DELIVERY_UNAVAILABLE",
			"The email could not be delivered. Please try again later",
		);
	}
	return { emailHint: identity.emailHint, expiresInSeconds: 600, retryAfterSeconds: 60 };
}
export async function verifySignerEmailCode(input: {
	token: string;
	code: string;
	now: Date;
	env: SignerEmailEnv;
}) {
	const secret = requireSecret(input.env);
	const identity = await inspectSignerEmail(input.token, input.now);
	const db = getDb();
	const challenge = await db.batch([
		signingStatement(
			sql`select id from signer_email_challenges where token_id=${identity.token.id}`,
		),
	]);
	const challengeId = challenge[0]?.rows[0]?.id;
	if (typeof challengeId !== "string") throw invalidCode();
	const codeHash = await hmac(
		secret,
		`${challengeId}:${identity.token.id}:${identity.email}:${input.code}`,
	);
	const rawSession = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
	const sessionHash = await hashSignerSession(rawSession);
	const expiresAt = new Date(
		Math.min(identity.token.expiresAt.getTime(), input.now.getTime() + 8 * 3600000),
	);
	const [result] = await db.batch([
		signingStatement(sql`with attempted as (
  update signer_email_challenges set attempts=attempts+1,
   consumed_at=case when code_hash=${codeHash} then ${input.now}::timestamptz else null end
  where id=${challengeId} and token_id=${identity.token.id} and email=${identity.email} and consumed_at is null and expires_at>${input.now} and attempts<5
   and exists(select 1 from signer_tokens t join envelopes e on e.id=t.envelope_id join envelope_recipients r on r.id=t.recipient_id
    where t.id=${identity.token.id} and t.status='active' and t.expires_at>${input.now} and e.status in ('sent','completed','changes_requested')
    and lower(trim(r.email))=${identity.email} and not exists(select 1 from audit_events a where a.envelope_id=e.id and a.event_type='envelope.deletion_started'))
  returning token_id,consumed_at
 ), verified as (
  update signer_tokens set verified_at=${input.now} where id in(select token_id from attempted where consumed_at is not null) returning id
 ), session as (
  insert into signer_email_sessions(token_id,envelope_id,recipient_id,email,session_hash,expires_at,created_at)
  select id,${identity.token.envelopeId},${identity.token.recipientId},${identity.email},${sessionHash},${expiresAt},${input.now} from verified returning id
 ) select id from session`),
	]);
	if (!result?.rows.length) throw invalidCode();
	return { rawSession, expiresAt, signingUrl: `/signing/${input.token}` };
}
function invalidCode() {
	return new SignerEmailError(
		400,
		"INVALID_EMAIL_CODE",
		"The code is invalid or expired. Request a new code if needed",
	);
}
function requireSecret(env: SignerEmailEnv): string {
	const secret = env.SIGN_OTP_SECRET;
	if (!secret || secret.length < 32)
		throw new SignerEmailError(
			503,
			"EMAIL_VERIFICATION_UNAVAILABLE",
			"Email verification is not configured",
		);
	return secret;
}
function randomCode(): string {
	const range = 4294000000;
	let n: number;
	do {
		n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
	} while (n >= range);
	return String(n % 1000000).padStart(6, "0");
}
async function hmac(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(`signmos:signer-email:v1:${value}`),
		),
	);
}
function hex(value: ArrayBuffer): string {
	return [...new Uint8Array(value)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function maskEmail(email: string): string {
	const [name, domain] = email.split("@");
	return `${name?.slice(0, 1) ?? ""}•••@${domain ?? ""}`;
}
