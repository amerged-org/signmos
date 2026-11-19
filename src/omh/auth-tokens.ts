import { and, eq } from "drizzle-orm";
import { generateAgenticToken, revokeAgenticToken } from "@/db/agentic-access";
import { hashAgenticCredential, normalizeAgenticEmail } from "@/db/agentic-access/request";
import {
	agenticAccessLinks,
	agenticManagementSessions,
	agenticSecurityEvents,
} from "@/db/agentic-access/table";
import type { VerifiedHistorySession } from "@/db/history-access";
import { getDb } from "@/db/setup";

export async function createAdminApiToken(
	session: VerifiedHistorySession,
	name: string,
	requestIp?: string,
): Promise<Awaited<ReturnType<typeof generateAgenticToken>>> {
	return withManagementSession(session, requestIp, (managementSession) =>
		generateAgenticToken({
			session: managementSession,
			name,
			requestIp,
			// Leave room for cookie authorization, the bridge and guaranteed cleanup.
			maximumAttempts: 3,
		}),
	);
}

export async function revokeAdminApiToken(
	session: VerifiedHistorySession,
	tokenId: string,
	requestIp?: string,
): Promise<Awaited<ReturnType<typeof revokeAgenticToken>>> {
	return withManagementSession(session, requestIp, (managementSession) =>
		revokeAgenticToken({ session: managementSession, tokenId, requestIp }),
	);
}

async function withManagementSession<T>(
	session: VerifiedHistorySession,
	requestIp: string | undefined,
	action: (session: { id: string; email: string; expiresAt: Date }) => Promise<T>,
): Promise<T> {
	const db = getDb();
	const email = normalizeAgenticEmail(session.email);
	const now = new Date();
	const linkId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();
	const expiresAt = new Date(Math.min(now.getTime() + 15 * 60 * 1000, session.expiresAt.getTime()));
	const [credentialHash, sessionHash] = await Promise.all([
		hashAgenticCredential(crypto.randomUUID()),
		hashAgenticCredential(crypto.randomUUID()),
	]);
	const audit = { linkId, sessionId, email, actorType: "browser", requestIp: requestIp ?? null };
	// Preselected IDs keep the identity bridge, its real session FK and its audit atomic.
	const results = await db.batch([
		db.insert(agenticAccessLinks).values({
			id: linkId,
			email,
			credentialHash,
			status: "consumed",
			expiresAt: now,
			activatedAt: now,
			consumedAt: now,
		}),
		db
			.insert(agenticManagementSessions)
			.values({ id: sessionId, linkId, email, sessionHash, status: "active", expiresAt })
			.returning(),
		db.insert(agenticSecurityEvents).values({ ...audit, eventType: "agentic.session.bridged" }),
	]);
	try {
		const inserted = results[1]?.rows[0];
		if (
			inserted?.id !== sessionId ||
			inserted.email !== email ||
			inserted.status !== "active" ||
			new Date(
				inserted.expires_at instanceof Date
					? inserted.expires_at.getTime()
					: String(inserted.expires_at),
			).getTime() !== expiresAt.getTime()
		) {
			throw new Error("Token management session could not be created");
		}
		return await action({ id: sessionId, email, expiresAt });
	} finally {
		await db.batch([
			db
				.update(agenticManagementSessions)
				.set({ status: "revoked" })
				.where(
					and(
						eq(agenticManagementSessions.id, sessionId),
						eq(agenticManagementSessions.email, email),
						eq(agenticManagementSessions.status, "active"),
					),
				),
			db.insert(agenticSecurityEvents).values({ ...audit, eventType: "agentic.session.revoked" }),
		]);
	}
}
