// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConsoleLogin } from "./console-login";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("requests a one-time email link without a password field", async () => {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
		Response.json(
			input === "/api/auth/session"
				? { data: { authenticated: false } }
				: { data: { status: "accepted" } },
		),
	);
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ConsoleLogin />
		</QueryClientProvider>,
	);
	expect(screen.queryByLabelText(/passwort/i)).toBeNull();
	fireEvent.change(screen.getByLabelText("Geschäftliche E-Mail-Adresse"), {
		target: { value: "person@example.com" },
	});
	fireEvent.click(screen.getByRole("button", { name: /Anmeldelink erhalten/ }));
	await screen.findByText("Schau in dein Postfach.");
	expect(fetchMock).toHaveBeenCalledWith(
		"/api/auth/request-login",
		expect.objectContaining({
			method: "POST",
			body: JSON.stringify({ email: "person@example.com" }),
		}),
	);
});
