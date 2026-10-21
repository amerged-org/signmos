import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverTransactionalEmail, isResendConfigured } from "@/db/envelope/email-delivery";
import { hasOmhMail, type OmhMailEnv, sendOmhMail } from "./mail";

const message = {
	to: "signer@example.test",
	subject: "Please sign the contract",
	text: "Open https://sign.example.test/signing/synthetic-token",
	html: '<a href="https://sign.example.test/signing/synthetic-token">Sign contract</a>',
};

function managedMail(state: "accepted" | "uncertain" = "accepted") {
	const requests: Pick<Request, "url" | "method" | "headers" | "json">[] = [];
	const fetcher = vi.fn(async (request: Request) => {
		requests.push(request.clone());
		return Response.json(
			{
				state,
				request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				...(state === "accepted" ? { message_id: "synthetic-message-1" } : {}),
			},
			{ status: 202 },
		);
	});
	const env: OmhMailEnv = {
		OHMYHOST_MAIL_GATEWAY: { fetch: fetcher } as unknown as Fetcher,
		OHMYHOST_MAIL_GATEWAY_URL: "https://private-mail.example.test",
		OHMYHOST_MAIL_KEY: "k".repeat(43),
		OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		SIGN_FROM_EMAIL: "contracts@example.test",
		SIGN_REPLY_TO_EMAIL: "reply@example.test",
	};
	return { env, fetcher, requests };
}

afterEach(() => vi.restoreAllMocks());

describe("managed OMH transactional mail", () => {
	it("sends through the private binding with the complete message and runtime credentials", async () => {
		const { env, fetcher, requests } = managedMail();
		const publicFetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Unexpected public request"));
		await expect(sendOmhMail(env, message)).resolves.toEqual({
			providerMessage: "synthetic-message-1",
		});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(publicFetch).not.toHaveBeenCalled();
		const request = requests[0];
		expect(request).toBeDefined();
		if (!request) throw new Error("Expected a gateway request");
		expect(request.url).toBe("https://private-mail.example.test/v1/send");
		expect(request.method).toBe("POST");
		expect(request.headers.get("authorization")).toBe(`Bearer ${env.OHMYHOST_MAIL_KEY}`);
		expect(request.headers.get("idempotency-key")).toMatch(/^sign\.[a-f0-9]{64}$/);
		await expect(request.json()).resolves.toEqual({
			project_id: env.OHMYHOST_PROJECT_ID,
			from: env.SIGN_FROM_EMAIL,
			reply_to: env.SIGN_REPLY_TO_EMAIL,
			...message,
		});
	});

	it("reuses the content idempotency key for identical retries and changes it for changed content", async () => {
		const { env, requests } = managedMail();
		await sendOmhMail(env, message);
		await sendOmhMail(env, { ...message });
		await sendOmhMail(env, { ...message, subject: "Please sign the revised contract" });
		const keys = requests.map((request) => request.headers.get("idempotency-key"));
		expect(keys[0]).toBeTruthy();
		expect(keys[1]).toBe(keys[0]);
		expect(keys[2]).not.toBe(keys[0]);
	});

	it.each([
		"OHMYHOST_MAIL_GATEWAY",
		"OHMYHOST_MAIL_GATEWAY_URL",
		"OHMYHOST_MAIL_KEY",
		"OHMYHOST_PROJECT_ID",
		"SIGN_FROM_EMAIL",
	] as const)("fails closed when %s is absent", async (field) => {
		const { env, fetcher } = managedMail();
		delete env[field];
		expect(hasOmhMail(env)).toBe(false);
		await expect(sendOmhMail(env, message)).rejects.toThrow("noch nicht konfiguriert");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects uncertain delivery so callers cannot record a fake provider acceptance", async () => {
		const { env, fetcher } = managedMail("uncertain");
		await expect(sendOmhMail(env, message)).rejects.toThrow("noch bestätigt");
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("routes managed application delivery through OMH even when upstream provider credentials exist", async () => {
		const { env, fetcher } = managedMail();
		const upstreamFetch = vi.fn(async () => Response.json({ id: "unexpected-upstream" }));
		const options = {
			baseUrl: "https://sign.example.test",
			env: {
				...env,
				RESEND_API_KEY: "synthetic-upstream-key",
				RESEND_FROM_EMAIL: "upstream@example.test",
				RESEND_REPLY_TO_EMAIL: "reply@example.test",
			},
			fetcher: upstreamFetch,
		};
		expect(isResendConfigured(options.env)).toBe(true);
		await expect(deliverTransactionalEmail(message, options)).resolves.toEqual({
			providerMessage: "synthetic-message-1",
		});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("propagates uncertain managed delivery without trying the upstream provider", async () => {
		const { env, fetcher } = managedMail("uncertain");
		const upstreamFetch = vi.fn(async () => Response.json({ id: "unexpected-upstream" }));
		await expect(
			deliverTransactionalEmail(message, {
				baseUrl: "https://sign.example.test",
				env: {
					...env,
					RESEND_API_KEY: "synthetic-upstream-key",
					RESEND_FROM_EMAIL: "upstream@example.test",
					RESEND_REPLY_TO_EMAIL: "reply@example.test",
				},
				fetcher: upstreamFetch,
			}),
		).rejects.toThrow("noch bestätigt");
		expect(fetcher).toHaveBeenCalledOnce();
		expect(upstreamFetch).not.toHaveBeenCalled();
	});

	it("retains the upstream provider path for explicitly configured local fixtures", async () => {
		const upstreamFetch = vi.fn(async () => Response.json({ id: "local-fixture-message" }));
		await expect(
			deliverTransactionalEmail(message, {
				baseUrl: "http://localhost",
				env: {
					CLOUDFLARE_ENV: "development",
					RESEND_API_KEY: "synthetic-upstream-key",
					RESEND_FROM_EMAIL: "upstream@example.test",
					RESEND_REPLY_TO_EMAIL: "reply@example.test",
				},
				fetcher: upstreamFetch,
			}),
		).resolves.toEqual({ providerMessage: "local-fixture-message" });
		expect(upstreamFetch).toHaveBeenCalledWith(
			"https://api.resend.com/emails",
			expect.objectContaining({ method: "POST" }),
		);
	});
});
