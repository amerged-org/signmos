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

/**
 * Every login mail spends one of the project's daily sends (10 on its first day, shared by Dev and
 * Prod), and the login request is public: anyone can type the administrator's address. Counting
 * the administrator's mails per 24 hours in one atomic upsert keeps a script from using up the
 * project's sends that invitations and signatures need. Returns false once the budget is spent.
 */
export async function takeAdminLoginMailBudget(input: {
	email: string;
	now: Date;
}): Promise<boolean> {
	const windowEnd = new Date(input.now.getTime() + adminLoginMailWindowMs);
	const [row] = await getDb()
		.insert(rateLimitRecords)
		.values({
			key: `email:${input.email.trim().toLowerCase()}`,
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
		})
		.returning({ attempts: rateLimitRecords.attempts });
	return (row?.attempts ?? Number.POSITIVE_INFINITY) <= ADMIN_LOGIN_MAILS_PER_DAY;
}
