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
import {
	assertHistoryRequestRateLimits,
	takeAdminLoginMailBudget,
} from "@/db/history-access/request-abuse";
import { getDb } from "@/db/setup";
import { type AdminAuthEnv, isAllowedAdmin } from "./auth";
import { isMailRefusedBeforeSending } from "./mail";

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
	// Answered like an unknown address: no mail, no signal to whoever is typing the address.
	const grant = await takeAdminLoginMailBudget({ email, now });
	if (!grant) return;
	const db = getDb();
	const link = await storeLoginLink(email, now, input.emailDelivery).catch(
		async (error: unknown) => {
			// No mail was asked for yet, for example because the link could not be stored or the app's
			// own address is not a URL: the unit goes back, or the fault would lock the administrator
			// out for the rest of the window. A failed hand-back leaves the unit spent.
			await grant.giveBack().catch(() => undefined);
			throw error;
		},
	);
	try {
		await deliverTransactionalEmail(
			{
				to: email,
				subject: "Dein Login für amerged Sign",
				text: `Öffne deinen sicheren Login-Link:\n${link.accessUrl}\n\nDer Link ist 15 Minuten gültig und kann einmal verwendet werden.`,
				html: `<p>Dein sicherer Login für amerged Sign:</p><p><a href="${link.accessUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Bei amerged Sign anmelden</a></p><p>Der Link ist 15 Minuten gültig und kann einmal verwendet werden.</p>`,
			},
			input.emailDelivery,
		);
	} catch (error) {
		// A refusal before the provider was contacted proves that no mail left: hand the unit back,
		// so that a failing platform cannot lock the administrator out. Any other failure may have
		// sent the mail, and its unit stays spent. A failed hand-back leaves the unit spent as well.
		if (isMailRefusedBeforeSending(error)) await grant.giveBack().catch(() => undefined);
		throw error;
	}
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

/** Stores the pending link and builds the address that the mail carries; nothing is sent yet. */
async function storeLoginLink(
	email: string,
	now: Date,
	delivery: EmailDeliveryOptions,
): Promise<{ id: string; accessUrl: string }> {
	const rawCredential = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const [stored] = await getDb()
		.insert(historyAccessLinks)
		.values({
			email,
			credentialHash: await hashHistoryCredential(rawCredential),
			status: "pending",
			expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
		})
		.returning();
	if (!stored) throw new Error("Administrator login was not created");
	return {
		id: stored.id,
		accessUrl: toAbsoluteDeliveryUrl(
			`/login#credential=${encodeURIComponent(rawCredential)}`,
			delivery,
		),
	};
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
