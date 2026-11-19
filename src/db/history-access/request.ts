import { and, eq, gt, inArray, ne } from "drizzle-orm";
import { envelopeRecipients, envelopes } from "@/db/envelope";
import {
	deliverTransactionalEmail,
	EmailDeliveryError,
	type EmailDeliveryOptions,
	toAbsoluteDeliveryUrl,
} from "@/db/envelope/email-delivery";
import { getDb } from "@/db/setup";
import { renderBrandedEmail } from "@/lib/branded-email";
import { assertHistoryRequestRateLimits } from "./request-abuse";
import { appendHistorySecurityEvent } from "./security-audit";
import { historyAccessLinks, historyAccessRequests, historyEmailRecords } from "./table";

const accessLinkTtlMs = 30 * 60 * 1000;

export interface HistoryAccessRequestResult {
	status: "accepted";
	accessUrl: string | null;
}

interface HistoryAccessRequestOptions {
	emailDelivery: EmailDeliveryOptions;
	idempotencyKey: string;
	requestIp: string;
	returnTo?: string;
	now?: Date;
}

export async function requestHistoryAccess(
	email: string,
	options: HistoryAccessRequestOptions,
): Promise<HistoryAccessRequestResult> {
	const normalizedEmail = normalizeHistoryEmail(email);
	const now = options.now ?? new Date();
	const existingRequest = await findHistoryAccessRequest(options.idempotencyKey);
	if (existingRequest) return acceptedWithoutCredential();

	await assertHistoryRequestRateLimits({
		email: normalizedEmail,
		requestIp: options.requestIp,
		now,
	});
	const request = await claimHistoryAccessRequest({
		email: normalizedEmail,
		idempotencyKey: options.idempotencyKey,
	});
	if (!request) return acceptedWithoutCredential();
	if (!(await hasMatchingRetainedEnvelope(normalizedEmail))) return acceptedWithoutCredential();

	const db = getDb();
	const priorLinks = (
		await db
			.select()
			.from(historyAccessLinks)
			.where(eq(historyAccessLinks.email, normalizedEmail))
			.limit(100)
	).filter(
		(link) =>
			link.email === normalizedEmail &&
			(link.status === "active" || link.status === "pending") &&
			link.expiresAt > now,
	);
	const rawCredential = crypto.randomUUID();
	const credentialHash = await hashHistoryCredential(rawCredential);
	const expiresAt = new Date(now.getTime() + accessLinkTtlMs);
	const [link] = await db
		.insert(historyAccessLinks)
		.values({
			email: normalizedEmail,
			credentialHash,
			status: "pending",
			expiresAt,
		})
		.returning();
	if (!link) throw new Error("History access link was not created");
	await db
		.update(historyAccessRequests)
		.set({ linkId: link.id })
		.where(eq(historyAccessRequests.id, request.id))
		.returning();
	await appendHistorySecurityEvent({
		linkId: link.id,
		email: normalizedEmail,
		eventType: "history.link.issued",
		requestIp: options.requestIp,
	});

	const accessUrl = toAbsoluteDeliveryUrl(
		`/history-access/${rawCredential}${
			options.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : ""
		}`,
		options.emailDelivery,
	);
	try {
		await deliverTransactionalEmail(
			buildHistoryAccessEmail({ email: normalizedEmail, accessUrl }),
			options.emailDelivery,
		);
	} catch (error) {
		await db
			.insert(historyEmailRecords)
			.values({
				linkId: link.id,
				email: normalizedEmail,
				kind: "history_access",
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
		.insert(historyEmailRecords)
		.values({
			linkId: link.id,
			email: normalizedEmail,
			kind: "history_access",
			deliveryStatus: "accepted",
		})
		.returning();
	await db.batch([
		db
			.update(historyAccessLinks)
			.set({ status: "revoked", revokedAt: now })
			.where(
				and(
					eq(historyAccessLinks.email, normalizedEmail),
					ne(historyAccessLinks.id, link.id),
					inArray(historyAccessLinks.status, ["pending", "active"]),
					gt(historyAccessLinks.expiresAt, now),
				),
			),
		db
			.update(historyAccessLinks)
			.set({ status: "active", activatedAt: now })
			.where(eq(historyAccessLinks.id, link.id)),
	]);
	if (priorLinks.length > 0) {
		for (const priorLink of priorLinks) {
			await appendHistorySecurityEvent({
				linkId: priorLink.id,
				email: normalizedEmail,
				eventType: "history.link.revoked",
				requestIp: options.requestIp,
			});
		}
	}

	return { status: "accepted", accessUrl };
}

export function buildHistoryAccessEmail(input: { email: string; accessUrl: string }) {
	return {
		to: input.email,
		subject: "Access your amerged Sign documents",
		text: `Open your secure My documents link:\n${input.accessUrl}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this email.`,
		html: renderBrandedEmail({
			lang: "en",
			eyebrow: "My documents",
			title: "Your secure link",
			paragraphs: ["Open your secure My documents link."],
			action: { label: "View My documents", url: input.accessUrl },
			note: "This link expires in 30 minutes and can be used once. If you did not request it, ignore this email.",
		}),
	};
}

export function normalizeHistoryEmail(email: string): string {
	return email.trim().toLowerCase();
}

export async function hashHistoryCredential(credential: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function findHistoryAccessRequest(idempotencyKey: string) {
	const rows = await getDb()
		.select()
		.from(historyAccessRequests)
		.where(eq(historyAccessRequests.idempotencyKey, idempotencyKey))
		.limit(1);
	return rows.find((request) => request.idempotencyKey === idempotencyKey) ?? null;
}

async function claimHistoryAccessRequest(input: { email: string; idempotencyKey: string }) {
	const rows = await getDb()
		.insert(historyAccessRequests)
		.values({ email: input.email, idempotencyKey: input.idempotencyKey })
		.onConflictDoNothing()
		.returning();
	return rows[0] ?? null;
}

async function hasMatchingRetainedEnvelope(email: string): Promise<boolean> {
	const db = getDb();
	const envelopeRows = await db.select().from(envelopes).limit(100);
	const recipientRows = await db
		.select()
		.from(envelopeRecipients)
		.where(eq(envelopeRecipients.email, email))
		.limit(100);
	return envelopeRows.some(
		(envelope) =>
			envelope.status !== "deleted" &&
			(normalizeHistoryEmail(envelope.createdBy) === email ||
				recipientRows.some(
					(recipient) =>
						recipient.envelopeId === envelope.id &&
						normalizeHistoryEmail(recipient.email) === email,
				)),
	);
}

function acceptedWithoutCredential(): HistoryAccessRequestResult {
	return { status: "accepted", accessUrl: null };
}
