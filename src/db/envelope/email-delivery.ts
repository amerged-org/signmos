import { hasOmhMail, type OmhMailEnv, sendOmhMail } from "@/omh/mail";

export interface EmailDeliveryEnv extends OmhMailEnv {
	APP_BASE_URL?: string;
	CLOUDFLARE_ENV?: string;
	EMAIL_DELIVERY_TEST_BYPASS?: string;
	RESEND_API_KEY?: string;
	RESEND_FROM_EMAIL?: string;
	RESEND_REPLY_TO_EMAIL?: string;
}

export interface EmailDeliveryOptions {
	env?: EmailDeliveryEnv;
	baseUrl: string;
	fetcher?: typeof fetch;
}

interface TransactionalEmail {
	to: string;
	subject: string;
	html: string;
	text: string;
}

interface PartnerVerificationEmailInput {
	email: string;
	recipientName: string;
	verificationUrl: string;
}

interface SenderVerificationEmailInput {
	email: string;
	senderName: string;
	verificationUrl: string;
}

interface SenderSigningEmailInput {
	email: string;
	senderName: string;
	signingUrl: string;
}

interface SenderPartnerSignedEmailInput {
	email: string;
	signerName: string;
	statusUrl: string;
}

interface SenderChangeRequestEmailInput {
	email: string;
	revisionUrl: string;
	comment: string;
}

interface HumanReviewEmailInput {
	email: string;
	documentName: string;
	actionLabel: string;
	agentName: string;
	consequence: string;
	expiresAt: string;
	reviewUrl: string;
}

interface ResendConfig {
	apiKey: string;
	fromEmail: string;
	replyToEmail: string;
}

export class EmailDeliveryError extends Error {
	constructor(
		public readonly status: number,
		public readonly responseText: string,
	) {
		super("Email provider rejected the message");
		this.name = "EmailDeliveryError";
	}
}

export function isResendConfigured(env: EmailDeliveryEnv | undefined): boolean {
	return hasOmhMail(env) || getResendConfig(env) !== null;
}

export async function deliverTransactionalEmail(
	email: TransactionalEmail,
	options: EmailDeliveryOptions,
): Promise<{ providerMessage: string | null }> {
	if (options.env?.OHMYHOST_PROJECT_ID) return sendOmhMail(options.env, email);
	const config = getResendConfig(options.env);
	if (!config) return { providerMessage: null };

	const response = await (options.fetcher ?? fetch)("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			authorization: `Bearer ${config.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			from: config.fromEmail,
			to: [email.to],
			subject: email.subject,
			html: email.html,
			text: email.text,
			reply_to: config.replyToEmail,
		}),
	});

	if (!response.ok) {
		throw new EmailDeliveryError(response.status, await response.text());
	}
	const body: unknown = await response.json().catch(() => null);
	return {
		providerMessage:
			body && typeof body === "object" && "id" in body && typeof body.id === "string"
				? body.id
				: null,
	};
}

export function buildPartnerVerificationEmail(
	input: PartnerVerificationEmailInput,
): TransactionalEmail {
	const name = input.recipientName.trim() || "zusammen";
	return {
		to: input.email,
		subject: "Deine Unterschrift wird benötigt · amerged Sign",
		text: `Hallo ${name},\n\nein Vertrag wartet auf deine Unterschrift. Über den persönlichen Link bestätigst du deine E-Mail-Adresse und kannst den Vertrag prüfen und unterschreiben:\n${input.verificationUrl}\n\nDer Link ist 7 Tage gültig.\n\namerged Sign`,
		html: `<p>Hallo ${escapeHtml(name)},</p><p>Ein Vertrag wartet auf deine Unterschrift. Über den persönlichen Link bestätigst du deine E-Mail-Adresse und kannst den Vertrag prüfen und unterschreiben.</p><p><a href="${escapeHtml(input.verificationUrl)}">Vertrag prüfen und unterschreiben</a></p><p>Der Link ist 7 Tage gültig.</p><p>amerged Sign</p>`,
	};
}

export function buildSenderVerificationEmail(
	input: SenderVerificationEmailInput,
): TransactionalEmail {
	const name = input.senderName.trim() || "zusammen";
	return {
		to: input.email,
		subject: "E-Mail-Adresse bestätigen · amerged Sign",
		text: `Hallo ${name},\n\nbestätige deine E-Mail-Adresse, um deinen Vertrag bei amerged Sign vorzubereiten:\n${input.verificationUrl}\n\nDer Link ist 30 Minuten gültig.\n\namerged Sign`,
		html: `<p>Hallo ${escapeHtml(name)},</p><p>Bestätige deine E-Mail-Adresse, um deinen Vertrag bei amerged Sign vorzubereiten.</p><p><a href="${escapeHtml(input.verificationUrl)}">E-Mail-Adresse bestätigen</a></p><p>Der Link ist 30 Minuten gültig.</p><p>amerged Sign</p>`,
	};
}

export function buildSenderSigningEmail(input: SenderSigningEmailInput): TransactionalEmail {
	const name = input.senderName.trim() || "zusammen";
	return {
		to: input.email,
		subject: "Dein Vertrag ist bereit zur Unterschrift · amerged Sign",
		text: `Hallo ${name},\n\ndein Vertrag ist bereit für deine Unterschrift:\n${input.signingUrl}\n\nDer Link ist 7 Tage gültig.\n\namerged Sign`,
		html: `<p>Hallo ${escapeHtml(name)},</p><p>Dein Vertrag ist bereit für deine Unterschrift.</p><p><a href="${escapeHtml(input.signingUrl)}">Vertrag unterschreiben</a></p><p>Der Link ist 7 Tage gültig.</p><p>amerged Sign</p>`,
	};
}

export function buildSenderPartnerSignedEmail(
	input: SenderPartnerSignedEmailInput,
): TransactionalEmail {
	const signerName = input.signerName.trim() || "Ein Empfänger";
	return {
		to: input.email,
		subject: "Dein Vertrag wurde unterzeichnet · amerged Sign",
		text: `${signerName} hat deinen Vertrag unterzeichnet.\n\nVertragsstatus ansehen:\n${input.statusUrl}\n\namerged Sign`,
		html: `<p>${escapeHtml(signerName)} hat deinen Vertrag unterzeichnet.</p><p><a href="${escapeHtml(input.statusUrl)}">Vertragsstatus ansehen</a></p><p>amerged Sign</p>`,
	};
}

export function buildSenderChangeRequestEmail(
	input: SenderChangeRequestEmailInput,
): TransactionalEmail {
	return {
		to: input.email,
		subject: "Änderungen an deinem Vertrag angefragt · amerged Sign",
		text: `Ein Empfänger hat vor der Unterschrift um Änderungen gebeten.\n\nKommentar:\n${input.comment}\n\nÜberarbeitete PDF hochladen:\n${input.revisionUrl}\n\namerged Sign`,
		html: `<p>Ein Empfänger hat vor der Unterschrift um Änderungen gebeten.</p><p><strong>Kommentar:</strong></p><p>${escapeHtml(input.comment)}</p><p><a href="${escapeHtml(input.revisionUrl)}">Überarbeitete PDF hochladen</a></p><p>amerged Sign</p>`,
	};
}

export function buildHumanReviewEmail(input: HumanReviewEmailInput): TransactionalEmail {
	const documentName = input.documentName.trim() || "Unbenannter Vertrag";
	const agentName = input.agentName.trim() || "Eine Anwendung";
	return {
		to: input.email,
		subject: `Freigabe angefragt: ${documentName} · amerged Sign`,
		text: `${agentName} fragt an: ${input.actionLabel}\n\nVertrag: ${documentName}\nAuswirkung: ${input.consequence}\nGültig bis: ${input.expiresAt}\n\nIn amerged Sign prüfen:\n${input.reviewUrl}`,
		html: `<p>${escapeHtml(agentName)} fragt an: <strong>${escapeHtml(input.actionLabel)}</strong>.</p><p><strong>Vertrag:</strong> ${escapeHtml(documentName)}</p><p><strong>Auswirkung:</strong> ${escapeHtml(input.consequence)}</p><p><strong>Gültig bis:</strong> ${escapeHtml(input.expiresAt)}</p><p><a href="${escapeHtml(input.reviewUrl)}">In amerged Sign prüfen</a></p>`,
	};
}

export function toAbsoluteDeliveryUrl(pathOrUrl: string, options: EmailDeliveryOptions): string {
	const baseUrl = (options.env?.APP_BASE_URL?.trim() || options.baseUrl).replace(/\/+$/, "");
	return new URL(pathOrUrl, baseUrl).toString();
}

function getResendConfig(env: EmailDeliveryEnv | undefined): ResendConfig | null {
	if (env?.CLOUDFLARE_ENV !== "production" && env?.EMAIL_DELIVERY_TEST_BYPASS === "true") {
		return null;
	}
	const apiKey = env?.RESEND_API_KEY?.trim();
	const fromEmail = env?.RESEND_FROM_EMAIL?.trim();
	const replyToEmail = env?.RESEND_REPLY_TO_EMAIL?.trim();
	if (!apiKey || !fromEmail || !replyToEmail) return null;
	return { apiKey, fromEmail, replyToEmail };
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
