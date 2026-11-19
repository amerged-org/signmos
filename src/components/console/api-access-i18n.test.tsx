// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { LanguageProvider } from "@/lib/i18n";
import { ApiAccess } from "./api-access";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	document.cookie = "amerged_sign_language=; Max-Age=0; Path=/";
});

it("switches API controls and retains an unfinished name across languages", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ data: [] })),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<LanguageProvider>
				<LanguageSwitcher />
				<ApiAccess csrfToken="csrf" />
			</LanguageProvider>
		</QueryClientProvider>,
	);
	await screen.findByText("Noch keine Schlüssel");
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Make" } });
	fireEvent.click(screen.getByRole("button", { name: "English" }));
	expect(screen.getByText("No keys yet")).toBeTruthy();
	expect(screen.getByRole("button", { name: "Create key" })).toBeTruthy();
	expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Make");
	fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
	expect(screen.getByText("Nog geen sleutels")).toBeTruthy();
	expect(screen.getByRole("button", { name: "Sleutel maken" })).toBeTruthy();
	expect((screen.getByLabelText("Naam") as HTMLInputElement).value).toBe("Make");
});
