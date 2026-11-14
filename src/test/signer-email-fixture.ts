/** Explicit mailbox-proof fixtures for lifecycle tests; OTP itself uses real SQL tests. */
export const signerEmailTestCookie =
	"signmos_signer_session=verified-signer-email-session-test-fixture";
export const signerEmailTestHash =
	"7ef9534a2ec257c776e14f7c4a05aeb91163217c437ab58971959037ad77a2e8";
export function signerEmailSessionFixtures(
	tokens: Array<Record<string, unknown>>,
	recipients: Array<Record<string, unknown>>,
) {
	return tokens.map((token) => ({
		tokenId: token.id,
		envelopeId: token.envelopeId,
		recipientId: token.recipientId,
		email: String(recipients.find((row) => row.id === token.recipientId)?.email ?? "")
			.trim()
			.toLowerCase(),
		sessionHash: signerEmailTestHash,
		expiresAt: token.expiresAt,
	}));
}
export async function signerEmailRequest(
	api: {
		request: (path: string, init?: RequestInit, env?: object) => Response | Promise<Response>;
	},
	path: string,
	init: RequestInit = {},
	env?: object,
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("cookie", signerEmailTestCookie);
	return api.request(path, { ...init, headers }, env);
}
