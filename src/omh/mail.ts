import { createTransactionalMailClient } from "@ohmyhost/customer-runtime/mail";

export interface OmhMailEnv {
	OHMYHOST_MAIL_GATEWAY_URL?: string;
	OHMYHOST_MAIL_KEY?: string;
	OHMYHOST_PROJECT_ID?: string;
	SIGN_FROM_EMAIL?: string;
	SIGN_REPLY_TO_EMAIL?: string;
}

/**
 * How long a mail without a deadline of its own, such as a login or invitation mail, waits for the
 * gateway; the runtime client's own default is 10 s and its maximum 30 s. The gateway answers only
 * after several database transactions and the provider call, and bounds its steps separately (5 s
 * to connect, 10 s per database query and 15 s for the provider call; platform repository,
 * apps/mail-gateway and packages/provider-resend). The platform has recorded sends of 5-10 s
 * (docs/plan/history/PLAN.md: "accepted sends take 5-10 s ... and can exceed the customer client's
 * 10 s timeout"; the comment "the 5-10 s Dev sends" in apps/mail-gateway/src/resend-send.ts) and of
 * 5-13 s (docs/plan/specs/2026-10-22-gateway-egress-forward.md, row L21). The client would abort a
 * send that still completes after 10 s, which turns an accepted mail into a 503 and a second send.
 * 25 s lies above the longest recorded send and below the client's maximum. It is a choice, not a
 * measurement: the platform plans one (its V18, the basis for published timeout guidance), and so
 * does the hosted acceptance of this app (runbook 8.3).
 */
const MAIL_GATEWAY_TIMEOUT_MILLISECONDS = 25_000;

/**
 * How long the owner notice after a signature waits for the gateway. The signer's answer waits for
 * this courtesy mail, so it gives up sooner than a login or invitation mail, but not inside the
 * 5-13 s the platform has recorded for sends (see above): a deadline there would abandon the
 * slowest notices on this side while the signer waits just as long. 15 s lies above the longest
 * recorded send. It is a choice, not a measurement; replace it with the platform's own figure or
 * with timed sends on the hosted platform. A notice abandoned at this deadline may still be sent by
 * the gateway; its content-derived idempotency key makes any later retry a gateway replay instead
 * of a second mail.
 */
export const OWNER_NOTICE_TIMEOUT_MILLISECONDS = 15_000;

type MailTransport = (request: Request) => Promise<Response>;

/**
 * Mail is sent with the global fetch. The platform's egress-policy Worker forwards a request to
 * the mail gateway privately, while the private service binding OHMYHOST_MAIL_GATEWAY answers 503
 * mail_gateway_unavailable as long as that policy is attached (observed 2026-10-22). Revisit this
 * when the platform repairs the binding. The global is called as `fetch(request)` at send time:
 * never store a detached reference to it, the Workers runtime binds the call.
 */
const globalFetchTransport: MailTransport = (request) => fetch(request);
let transport: MailTransport = globalFetchTransport;

/** Test seam: replaces the mail transport; `null` restores the global fetch. */
export function setOmhMailTransport(replacement: MailTransport | null): void {
	transport = replacement ?? globalFetchTransport;
}

/** The gateway accepted the request but cannot yet prove delivery; the message may have been sent. */
export class MailDeliveryUncertainError extends Error {
	constructor() {
		super("E-Mail-Versand wird noch bestätigt. Bitte denselben Vorgang erneut prüfen.");
		this.name = "MailDeliveryUncertainError";
	}
}

export function hasOmhMail(env: OmhMailEnv | undefined): boolean {
	return Boolean(
		env?.OHMYHOST_MAIL_GATEWAY_URL &&
			env.OHMYHOST_MAIL_KEY &&
			env.OHMYHOST_PROJECT_ID &&
			env.SIGN_FROM_EMAIL,
	);
}

/**
 * Sends one mail through the platform's mail gateway. `timeoutMilliseconds` replaces the default
 * gateway deadline for this send only; the runtime client accepts 100 to 30,000.
 */
export async function sendOmhMail(
	env: OmhMailEnv,
	mail: { to: string; subject: string; text: string; html: string },
	options: { timeoutMilliseconds?: number } = {},
): Promise<{ providerMessage: string }> {
	if (
		!hasOmhMail(env) ||
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
	const client = createTransactionalMailClient({
		endpoint: env.OHMYHOST_MAIL_GATEWAY_URL,
		key: env.OHMYHOST_MAIL_KEY,
		projectId: env.OHMYHOST_PROJECT_ID,
		fetch: (request) => transport(request),
		timeoutMilliseconds: options.timeoutMilliseconds ?? MAIL_GATEWAY_TIMEOUT_MILLISECONDS,
	});
	const result = await client.send({
		...mail,
		from: env.SIGN_FROM_EMAIL,
		replyTo: env.SIGN_REPLY_TO_EMAIL,
		idempotencyKey,
	});
	if (result.state !== "accepted") throw new MailDeliveryUncertainError();
	return { providerMessage: result.messageId };
}
