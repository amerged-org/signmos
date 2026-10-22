import { startInstance } from "@/start";
import { hostedRequestMiddleware } from "./hosted-middleware";

// The Workers runtime provides this module; the Worker environment is what the platform bound.
vi.mock("cloudflare:workers", () => ({ env: { SIGN_ADMIN_EMAILS: "owner@example.com" } }));

type RunMiddleware = (options: {
	request: Request;
	next: () => Promise<unknown>;
}) => Promise<Response | unknown>;
const run = hostedRequestMiddleware.options.server as unknown as RunMiddleware;

describe("the hosted gate as TanStack Start's request middleware", () => {
	it("answers an API request itself with the Worker environment, before the app", async () => {
		const next = vi.fn(async () => "app-response");
		const response = (await run({
			request: new Request("https://sign.example.com/api/contracts"),
			next,
		})) as Response;
		// No session: the gate in front of the API denies it, so the app never sees the request.
		expect(response.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
	});

	it("hands a public page on to the app", async () => {
		const next = vi.fn(async () => "app-response");
		await expect(
			run({ request: new Request("https://sign.example.com/login"), next }),
		).resolves.toBe("app-response");
		expect(next).toHaveBeenCalledOnce();
	});

	it("is the first request middleware the app registers, ahead of the framework's own", async () => {
		const options = await startInstance.getOptions();
		expect(options.requestMiddleware?.[0]).toBe(hostedRequestMiddleware);
	});
});
