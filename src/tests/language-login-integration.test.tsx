// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConsoleLogin } from "@/components/console/console-login";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { LanguageProvider } from "@/lib/i18n";

function renderLogin() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<LanguageProvider>
			<LanguageSwitcher />
			<QueryClientProvider client={client}>
				<ConsoleLogin />
			</QueryClientProvider>
		</LanguageProvider>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
	window.history.replaceState(null, "", "/");
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	window.localStorage.clear();
});

it("switches languages without losing the login address and restores the choice", async () => {
	const fetcher = vi.fn(async (input: RequestInfo | URL) =>
		Response.json(
			input === "/api/auth/session"
				? { data: { authenticated: false } }
				: { data: { status: "accepted" } },
		),
	);
	vi.stubGlobal("fetch", fetcher);
	const view = renderLogin();
	fireEvent.change(screen.getByLabelText("E-Mail-Adresse"), {
		target: { value: "person@example.com" },
	});
	fireEvent.click(screen.getByRole("button", { name: "English" }));
	expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("true");
	expect(screen.getByLabelText("Email address")).toHaveProperty("value", "person@example.com");
	fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
	expect(screen.getByRole("button", { name: "Nederlands" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
	expect(screen.getByLabelText("E-mailadres")).toHaveProperty("value", "person@example.com");
	fireEvent.click(screen.getByRole("button", { name: "Link versturen" }));
	await screen.findByText("Controleer je inbox.");
	expect(fetcher).toHaveBeenCalledWith(
		"/api/auth/request-login",
		expect.objectContaining({
			method: "POST",
			body: JSON.stringify({ email: "person@example.com" }),
		}),
	);
	expect(window.localStorage.getItem("amerged-sign-language")).toBe("nl");
	view.unmount();
	renderLogin();
	await waitFor(() => expect(screen.getByLabelText("E-mailadres")).toBeTruthy());
});

it("keeps language switching usable when browser storage is blocked", () => {
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new DOMException("blocked", "SecurityError");
	});
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new DOMException("blocked", "SecurityError");
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ data: { authenticated: false } })),
	);
	renderLogin();
	fireEvent.click(screen.getByRole("button", { name: "English" }));
	expect(screen.getByLabelText("Email address")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
	expect(screen.getByLabelText("E-mailadres")).toBeTruthy();
});

it("shows the selected language when login delivery fails", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) =>
			input === "/api/auth/session"
				? Response.json({ data: { authenticated: false } })
				: Response.json({ error: { message: "Backend error" } }, { status: 503 }),
		),
	);
	renderLogin();
	fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
	fireEvent.change(screen.getByLabelText("E-mailadres"), {
		target: { value: "person@example.com" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Link versturen" }));
	await screen.findByText("Inloggen mislukt");
	expect(screen.getByText("Probeer het opnieuw.")).toBeTruthy();
	expect(screen.queryByText("Backend error")).toBeNull();
});
