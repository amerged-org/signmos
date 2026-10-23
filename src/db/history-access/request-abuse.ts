import { and, eq, sql } from "drizzle-orm";
import { rateLimitRecords } from "@/db/envelope";
import { getDb } from "@/db/setup";

const historyRequestRateLimitOperation = "history-access-request";
const historyRequestMaxAttempts = 5;
const historyRequestWindowMs = 10 * 60 * 1000;
const adminLoginMailOperation = "admin-login-mail";
export const ADMIN_LOGIN_MAILS_PER_DAY = 4;
const adminLoginMailWindowMs = 24 * 60 * 60 * 1000;

type HistoryRequestRateScope = "ip" | "email";

type RateLimitRecord = {
	id: string;
	key: string;
	operation: string;
	attempts: number;
	resetAt: Date;
};

export class HistoryRequestRateLimitError extends Error {
	constructor(
		public readonly scope: HistoryRequestRateScope,
		public readonly resetAt: Date,
	) {
		super("History access request rate limit exceeded");
		this.name = "HistoryRequestRateLimitError";
	}
}

export async function assertHistoryRequestRateLimits(input: {
	email: string;
	requestIp: string;
	now: Date;
}): Promise<void> {
	await assertHistoryRequestRateLimit({
		key: `ip:${input.requestIp}`,
		scope: "ip",
		now: input.now,
	});
	await assertHistoryRequestRateLimit({
		key: `email:${input.email.trim().toLowerCase()}`,
		scope: "email",
		now: input.now,
	});
}

async function assertHistoryRequestRateLimit(input: {
	key: string;
	scope: HistoryRequestRateScope;
	now: Date;
}): Promise<void> {
	const db = getDb();
	const rows = await db
		.select()
		.from(rateLimitRecords)
		.where(
			and(
				eq(rateLimitRecords.key, input.key),
				eq(rateLimitRecords.operation, historyRequestRateLimitOperation),
			),
		)
		.limit(10);
	const record = rows.find(
		(candidate) =>
			candidate.key === input.key && candidate.operation === historyRequestRateLimitOperation,
	) as RateLimitRecord | undefined;
	const nextResetAt = new Date(input.now.getTime() + historyRequestWindowMs);
	if (!record) {
		await db
			.insert(rateLimitRecords)
			.values({
				key: input.key,
				operation: historyRequestRateLimitOperation,
				attempts: 1,
				resetAt: nextResetAt,
				updatedAt: input.now,
			})
			.returning();
		return;
	}

	const activeWindow = record.resetAt > input.now;
	if (activeWindow && record.attempts >= historyRequestMaxAttempts) {
		throw new HistoryRequestRateLimitError(input.scope, record.resetAt);
	}

	await db
		.update(rateLimitRecords)
		.set({
			key: input.key,
			operation: historyRequestRateLimitOperation,
			attempts: activeWindow ? record.attempts + 1 : 1,
			resetAt: activeWindow ? record.resetAt : nextResetAt,
			updatedAt: input.now,
		})
		.where(eq(rateLimitRecords.id, record.id));
}

/** One unit of the login mail budget, which its holder can hand back. */
export interface AdminLoginMailGrant {
	/**
	 * Gives the unit back after a send that provably sent nothing. Only the first call has an effect,
	 * and only while the window the unit was taken from is the current one.
	 */
	giveBack(): Promise<void>;
}

/**
 * Every login mail spends one of the project's daily sends (10 on its first day, shared by Dev and
 * Prod), and the login request is public: anyone can type the administrator's address. Counting
 * the administrator's mails per 24 hours in one atomic upsert keeps a script from using up the
 * project's sends that invitations and signatures need. Returns null once the budget is spent.
 *
 * The stored count is the number of units out in the window. A request over the budget changes
 * nothing, so the units that are handed back add up to an empty budget however many requests were
 * turned away at the same time.
 *
 * The unit is taken before the send. When the request proves that no mail left, because the
 * platform refused the send before it contacted the mail provider or because it failed before it
 * asked for one, the caller hands the unit back with one atomic update, so that a misconfiguration
 * or an unpaid workspace cannot lock the administrator out. The budget still bounds the mails that
 * can have left, because a unit is returned only for a request that sent none; the ten-minute
 * request limiter keeps counting every request, refused or not.
 */
export async function takeAdminLoginMailBudget(input: {
	email: string;
	now: Date;
}): Promise<AdminLoginMailGrant | null> {
	const db = getDb();
	const key = `email:${input.email.trim().toLowerCase()}`;
	const windowEnd = new Date(input.now.getTime() + adminLoginMailWindowMs);
	const [row] = await db
		.insert(rateLimitRecords)
		.values({
			key,
			operation: adminLoginMailOperation,
			attempts: 1,
			resetAt: windowEnd,
			updatedAt: input.now,
		})
		.onConflictDoUpdate({
			target: [rateLimitRecords.key, rateLimitRecords.operation],
			set: {
				attempts: sql`case when ${rateLimitRecords.resetAt} > ${input.now} then ${rateLimitRecords.attempts} + 1 else 1 end`,
				resetAt: sql`case when ${rateLimitRecords.resetAt} > ${input.now} then ${rateLimitRecords.resetAt} else ${windowEnd} end`,
				updatedAt: input.now,
			},
			// Inside a window whose budget is spent the row is left alone and nothing is returned.
			setWhere: sql`${rateLimitRecords.resetAt} <= ${input.now} or ${rateLimitRecords.attempts} < ${ADMIN_LOGIN_MAILS_PER_DAY}`,
		})
		.returning({ resetAt: rateLimitRecords.resetAt });
	if (!row) return null;
	let givenBack = false;
	return {
		async giveBack() {
			if (givenBack) return;
			givenBack = true;
			// Relative to the stored count and only inside the window the unit came from: a window that
			// ended while the send was in flight has a new count that this unit never belonged to.
			await db
				.update(rateLimitRecords)
				.set({
					attempts: sql`greatest(${rateLimitRecords.attempts} - 1, 0)`,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(rateLimitRecords.key, key),
						eq(rateLimitRecords.operation, adminLoginMailOperation),
						eq(rateLimitRecords.resetAt, row.resetAt),
					),
				);
		},
	};
}
