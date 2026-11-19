import { eq } from "drizzle-orm";
import {
	deliverTransactionalEmail,
	EmailDeliveryError,
	type EmailDeliveryOptions,
	toAbsoluteDeliveryUrl,
} from "@/db/envelope/email-delivery";
import { getDb } from "@/db/setup";
import { renderBrandedEmail } from "@/lib/branded-email";
import { appendAgenticSecurityEvent } from "./security-audit";
import { agenticAccessLinks, agenticAccessRequests, agenticEmailRecords } from "./table";

const agenticAccessLinkTtlMs = 30 * 60 * 1000;

export interface AgenticAccessRequestResult {
	status: "accepted";
	accessUrl: string | null;
}

interface AgenticAccessRequestOptions {
	emailDelivery: EmailDeliveryOptions;
	idempotencyKey: string;
	requestIp: string;
	now?: Date;
}

export async function requestAgenticAccess(
	email: string,
	options: AgenticAccessRequestOptions,
): Promise<AgenticAccessRequestResult> {
	const normalizedEmail = normalizeAgenticEmail(email);
	const db = getDb();
	const prior = await db
		.select()
		.from(agenticAccessRequests)
		.where(eq(agenticAccessRequests.idempotencyKey, options.idempotencyKey))
		.limit(1);
	if (prior.some((request) => request.idempotencyKey === options.idempotencyKey)) {
		return acceptedWithoutCredential();
	}

	const requests = await db
		.insert(agenticAccessRequests)
		.values({ email: normalizedEmail, idempotencyKey: options.idempotencyKey })
		.onConflictDoNothing()
		.returning();
	const request = requests[0];
	if (!request) return acceptedWithoutCredential();

	const now = options.now ?? new Date();
	const rawCredential = crypto.randomUUID();
	const credentialHash = await hashAgenticCredential(rawCredential);
	const expiresAt = new Date(now.getTime() + agenticAccessLinkTtlMs);
	const links = await db
		.insert(agenticAccessLinks)
		.values({
			email: normalizedEmail,
			credentialHash,
			status: "pending",
			expiresAt,
		})
		.returning();
	const link = links[0];
	if (!link) throw new Error("Agentic access link was not created");
	await db
		.update(agenticAccessRequests)
		.set({ linkId: link.id })
		.where(eq(agenticAccessRequests.id, request.id))
		.returning();
	await appendAgenticSecurityEvent({
		linkId: link.id,
		email: normalizedEmail,
		eventType: "agentic.link.issued",
		requestIp: options.requestIp,
	});

	const accessPageUrl = toAbsoluteDeliveryUrl("/agentic-access", options.emailDelivery);
	const accessUrl = `${accessPageUrl}#${encodeURIComponent(rawCredential)}`;
	try {
		await deliverTransactionalEmail(
			buildAgenticAccessEmail({ email: normalizedEmail, accessUrl }),
			options.emailDelivery,
		);
	} catch (error) {
		await db
			.insert(agenticEmailRecords)
			.values({
				linkId: link.id,
				email: normalizedEmail,
				kind: "agentic_access",
				deliveryStatus: "failed",
				providerMessage:
					error instanceof EmailDeliveryError
						? `Email provider rejected the message (${error.status})`
						: "Email delivery failed",
			})
			.returning();
		return acceptedWithoutCredential();
	}

	await db
		.insert(agenticEmailRecords)
		.values({
			linkId: link.id,
			email: normalizedEmail,
			kind: "agentic_access",
			deliveryStatus: "accepted",
		})
		.returning();
	await db
		.update(agenticAccessLinks)
		.set({ status: "active", activatedAt: now })
		.where(eq(agenticAccessLinks.id, link.id))
		.returning();

	return { status: "accepted", accessUrl };
}

export function normalizeAgenticEmail(email: string): string {
	return email.trim().toLowerCase();
}

export async function hashAgenticCredential(credential: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildAgenticAccessEmail(input: { email: string; accessUrl: string }) {
	return {
		to: input.email,
		subject: "Verify your email for amerged Sign access",
		text: `Open your secure Agentic access link:\n${input.accessUrl}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this email.`,
		html: renderBrandedEmail({
			lang: "en",
			eyebrow: "Agentic access",
			title: "Your secure link",
			paragraphs: ["Open your secure Agentic access link."],
			action: { label: "Manage Agentic access", url: input.accessUrl },
			note: "This link expires in 30 minutes and can be used once. If you did not request it, ignore this email.",
		}),
	};
}

function acceptedWithoutCredential(): AgenticAccessRequestResult {
	return { status: "accepted", accessUrl: null };
}
