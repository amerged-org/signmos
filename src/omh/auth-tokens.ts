import {
	createAgenticManagementSessionFromVerifiedIdentity,
	generateAgenticToken,
	resolveAgenticManagementSession,
	revokeAgenticManagementSession,
	revokeAgenticToken,
} from "@/db/agentic-access";
import type { VerifiedHistorySession } from "@/db/history-access";

export async function createAdminApiToken(
	session: VerifiedHistorySession,
	name: string,
	requestIp?: string,
): Promise<Awaited<ReturnType<typeof generateAgenticToken>>> {
	return withManagementSession(session, requestIp, (managementSession) =>
		generateAgenticToken({ session: managementSession, name, requestIp }),
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
	const bridge = await createAgenticManagementSessionFromVerifiedIdentity({
		email: session.email,
		requestIp,
	});
	try {
		const verified = await resolveAgenticManagementSession(bridge.rawSession);
		if (verified.state !== "active")
			throw new Error("Token management session could not be created");
		return await action(verified.session);
	} finally {
		await revokeAgenticManagementSession(bridge.rawSession);
	}
}
