import { and, eq, gt, inArray, ne } from "drizzle-orm";
import {
	deliverTransactionalEmail,
	type EmailDeliveryOptions,
	isResendConfigured,
	toAbsoluteDeliveryUrl,
} from "@/db/envelope/email-delivery";
import {
	hashHistoryCredential,
	historyAccessLinks,
	redeemHistoryAccessLink,
} from "@/db/history-access";
import { assertHistoryRequestRateLimits } from "@/db/history-access/request-abuse";
import { getDb } from "@/db/setup";
import { type AdminAuthEnv, isAllowedAdmin } from "./auth";

export async function requestAdminLogin(input: {
	email: string;
	env: AdminAuthEnv;
	requestIp: string;
	emailDelivery: EmailDeliveryOptions;
}): Promise<void> {
	const email = input.email.trim().toLowerCase();
	const now = new Date();
	await assertHistoryRequestRateLimits({ email, requestIp: input.requestIp, now });
	if (!isAllowedAdmin(email, input.env)) return;
	if (!isResendConfigured(input.emailDelivery.env))
		throw new Error("Administrator login email is not configured");
	const db = getDb();
	const rawCredential = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const [link] = await db
		.insert(historyAccessLinks)
		.values({
			email,
			credentialHash: await hashHistoryCredential(rawCredential),
			status: "pending",
			expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
		})
		.returning();
	if (!link) throw new Error("Administrator login was not created");
	const accessUrl = toAbsoluteDeliveryUrl(
		`/login#credential=${encodeURIComponent(rawCredential)}`,
		input.emailDelivery,
	);
	await deliverTransactionalEmail(
		{
			to: email,
			subject: "Dein Login für amerged Sign",
			text: `Öffne deinen sicheren Login-Link:\n${accessUrl}\n\nDer Link ist 15 Minuten gültig und kann einmal verwendet werden.`,
			html: `<p>Dein sicherer Login für amerged Sign:</p><p><a href="${accessUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Bei amerged Sign anmelden</a></p><p>Der Link ist 15 Minuten gültig und kann einmal verwendet werden.</p>`,
		},
		input.emailDelivery,
	);
	await db.batch([
		db
			.update(historyAccessLinks)
			.set({ status: "revoked", revokedAt: now })
			.where(
				and(
					eq(historyAccessLinks.email, email),
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
}

export async function redeemAdminLogin(input: {
	credential: string;
	env: AdminAuthEnv;
	requestIp: string;
}): Promise<Awaited<ReturnType<typeof redeemHistoryAccessLink>>> {
	const hash = await hashHistoryCredential(input.credential);
	const rows = await getDb()
		.select()
		.from(historyAccessLinks)
		.where(eq(historyAccessLinks.credentialHash, hash))
		.limit(1);
	const link = rows.find((candidate) => candidate.credentialHash === hash);
	if (!link || !isAllowedAdmin(link.email, input.env)) return { status: "unknown" };
	return redeemHistoryAccessLink(input.credential, new Date(), input.requestIp);
}
