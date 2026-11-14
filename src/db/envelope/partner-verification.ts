import { getDb } from "@/db/setup";
import { inspectSignerEmail, SignerEmailError } from "@/db/signer-email";
import type { SignerToken } from "./schema";
import { auditEvents } from "./table";

/** Scanner-safe inspection; a GET is never proof of mailbox control. */
export async function verifyPartnerToken(tokenValue: string, now = new Date()) {
	try {
		const identity = await inspectSignerEmail(tokenValue, now);
		return {
			ok: true as const,
			data: {
				status: "email_verification_required" as const,
				emailHint: identity.emailHint,
				signingLink: { token: tokenValue, url: `/signing/${tokenValue}` },
			},
		};
	} catch (error) {
		if (error instanceof SignerEmailError)
			return {
				ok: false as const,
				error: { status: error.status, code: error.code, message: error.message },
			};
		throw error;
	}
}
export async function recordPartnerLinkExpired(token: SignerToken): Promise<void> {
	await getDb()
		.insert(auditEvents)
		.values({
			envelopeId: token.envelopeId,
			recipientId: token.recipientId,
			eventType: "partner.link.expired",
			message: null,
		})
		.returning();
}
