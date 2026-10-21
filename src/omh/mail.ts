import { createTransactionalMailClient } from "@ohmyhost/customer-runtime/mail";

export interface OmhMailEnv {
	OHMYHOST_MAIL_GATEWAY?: Fetcher;
	OHMYHOST_MAIL_GATEWAY_URL?: string;
	OHMYHOST_MAIL_KEY?: string;
	OHMYHOST_PROJECT_ID?: string;
	SIGN_FROM_EMAIL?: string;
	SIGN_REPLY_TO_EMAIL?: string;
}

export function hasOmhMail(env: OmhMailEnv | undefined): boolean {
	return Boolean(
		env?.OHMYHOST_MAIL_GATEWAY &&
			env.OHMYHOST_MAIL_GATEWAY_URL &&
			env.OHMYHOST_MAIL_KEY &&
			env.OHMYHOST_PROJECT_ID &&
			env.SIGN_FROM_EMAIL,
	);
}

export async function sendOmhMail(
	env: OmhMailEnv,
	mail: { to: string; subject: string; text: string; html: string },
): Promise<{ providerMessage: string }> {
	if (
		!hasOmhMail(env) ||
		!env.OHMYHOST_MAIL_GATEWAY ||
		!env.OHMYHOST_MAIL_GATEWAY_URL ||
		!env.OHMYHOST_MAIL_KEY ||
		!env.OHMYHOST_PROJECT_ID
	) {
		throw new Error("Vertrags-E-Mail ist noch nicht konfiguriert.");
	}
	const canonical = {
		from: env.SIGN_FROM_EMAIL,
		replyTo: env.SIGN_REPLY_TO_EMAIL ?? null,
		to: mail.to,
		subject: mail.subject,
		text: mail.text,
		html: mail.html,
	};
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(canonical)),
	);
	const idempotencyKey = `sign.${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	const gateway = env.OHMYHOST_MAIL_GATEWAY;
	const client = createTransactionalMailClient({
		endpoint: env.OHMYHOST_MAIL_GATEWAY_URL,
		key: env.OHMYHOST_MAIL_KEY,
		projectId: env.OHMYHOST_PROJECT_ID,
		fetch: (request) => gateway.fetch(request),
	});
	const result = await client.send({
		...mail,
		from: env.SIGN_FROM_EMAIL,
		replyTo: env.SIGN_REPLY_TO_EMAIL,
		idempotencyKey,
	});
	if (result.state !== "accepted")
		throw new Error("E-Mail-Versand wird noch bestätigt. Bitte denselben Vorgang erneut prüfen.");
	return { providerMessage: result.messageId };
}
