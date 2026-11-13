import { dispatchHostedRequest } from "./hosted-request";

const env = { SIGN_ADMIN_EMAILS: "admin@example.com" } as Env;
const next = vi.fn(async (_request: Request) => new Response("page"));

describe("hosted request routing", () => {
	beforeEach(() => next.mockClear());

	it("serves health and the public API specification without an admin session", async () => {
		const health = await dispatchHostedRequest(
			new Request("https://sign.test/api/health/live"),
			env,
			next,
		);
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ status: "ok" });
		const openapi = await dispatchHostedRequest(
			new Request("https://sign.test/openapi.json"),
			env,
			next,
		);
		expect(openapi.status).toBe(200);
		expect(await openapi.json()).toMatchObject({ openapi: expect.any(String) });
		expect(next).not.toHaveBeenCalled();
	});

	it("preserves the admin and legacy access boundaries", async () => {
		const page = await dispatchHostedRequest(new Request("https://sign.test/"), env, next);
		expect(page.status).toBe(303);
		expect(page.headers.get("location")).toBe("/login");
		const api = await dispatchHostedRequest(
			new Request("https://sign.test/api/contracts"),
			env,
			next,
		);
		expect(api.status).toBe(403);
		const legacy = await dispatchHostedRequest(
			new Request("https://sign.test/api/agentic/tokens"),
			env,
			next,
		);
		expect(legacy.status).toBe(404);
		expect(next).not.toHaveBeenCalled();
	});

	it("sanitizes internal headers before passing a public page onward", async () => {
		const request = new Request("https://sign.test/login", {
			headers: { "x-internal-user-id": "spoof" },
		});
		const result = await dispatchHostedRequest(request, env, next);
		expect(result.status).toBe(200);
		expect(next.mock.calls[0]?.[0].headers.has("x-internal-user-id")).toBe(false);
	});
});
