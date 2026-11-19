// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider } from "@/lib/i18n";
import { ConsoleLogin } from "./console-login";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	document.cookie = "amerged_sign_language=; Path=/; Max-Age=0";
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
	fireEvent.change(screen.getByLabelText("E-Mail-Adresse"), {
		target: { value: "person@example.com" },
	});
	fireEvent.click(screen.getByRole("button", { name: /Link senden/ }));
	await screen.findByText("Prüfe dein Postfach.");
	expect(fetchMock).toHaveBeenCalledWith(
		"/api/auth/request-login",
		expect.objectContaining({
			method: "POST",
			body: JSON.stringify({ email: "person@example.com" }),
		}),
	);
});

it("switches language without clearing the email or changing the login request", async () => {
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
			<LanguageProvider>
				<ConsoleLogin />
			</LanguageProvider>
		</QueryClientProvider>,
	);
	fireEvent.change(screen.getByLabelText("E-Mail-Adresse"), {
		target: { value: "person@example.com" },
	});
	fireEvent.click(screen.getByRole("button", { name: "English" }));
	expect(screen.getByLabelText("Email address")).toHaveProperty("value", "person@example.com");
	fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
	expect(screen.getByLabelText("E-mailadres")).toHaveProperty("value", "person@example.com");
	fireEvent.click(screen.getByRole("button", { name: "Link versturen" }));
	await screen.findByText("Controleer je inbox.");
	expect(fetchMock).toHaveBeenCalledWith(
		"/api/auth/request-login",
		expect.objectContaining({
			body: JSON.stringify({ email: "person@example.com" }),
		}),
	);
});
