// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { LanguageProvider, useLanguage } from "./i18n";

function CurrentLanguage() {
	const { language } = useLanguage();
	return <p>{language}</p>;
}

afterEach(() => {
	cleanup();
	localStorage.removeItem("amerged-sign-language");
	window.history.replaceState(null, "", "/");
});

it("does not modify or derive the language from the URL", () => {
	window.history.replaceState(null, "", "/login?lang=en&next=contracts#credential=secret");
	const replace = vi.spyOn(window.history, "replaceState");
	render(
		<LanguageProvider>
			<CurrentLanguage />
		</LanguageProvider>,
	);
	expect(replace).not.toHaveBeenCalled();
	expect(screen.getByText("de")).toBeTruthy();
	expect(window.location.search).toBe("?lang=en&next=contracts");
	expect(window.location.hash).toBe("#credential=secret");
	replace.mockRestore();
});

it("switches immediately and restores the selection after remount", async () => {
	const view = render(
		<LanguageProvider>
			<LanguageSwitcher />
			<CurrentLanguage />
		</LanguageProvider>,
	);
	expect(screen.getByRole("button", { name: "Deutsch" }).getAttribute("aria-pressed")).toBe("true");
	fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
	expect(screen.getByText("nl")).toBeTruthy();
	expect(document.documentElement.lang).toBe("nl");
	expect(screen.getByRole("button", { name: "Nederlands" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
	expect(localStorage.getItem("amerged-sign-language")).toBe("nl");
	expect(document.cookie).not.toContain("amerged_sign_language=");
	view.unmount();
	render(
		<LanguageProvider>
			<LanguageSwitcher />
			<CurrentLanguage />
		</LanguageProvider>,
	);
	await waitFor(() => expect(screen.getByText("nl")).toBeTruthy());
});

it("ignores invalid stored values and remains usable when storage is blocked", () => {
	localStorage.setItem("amerged-sign-language", "fr");
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	render(
		<LanguageProvider>
			<LanguageSwitcher />
			<CurrentLanguage />
		</LanguageProvider>,
	);
	expect(screen.getByText("de")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "English" }));
	expect(screen.getByText("en")).toBeTruthy();
	expect(document.documentElement.lang).toBe("en");
	vi.restoreAllMocks();
});

it("renders the same deterministic default on the server", () => {
	const html = renderToString(
		<LanguageProvider>
			<LanguageSwitcher />
			<CurrentLanguage />
		</LanguageProvider>,
	);
	expect(html).toContain('aria-label="Deutsch"');
	expect(html).toContain(">de</p>");
});

it("responds to language changes in another tab", async () => {
	render(
		<LanguageProvider>
			<CurrentLanguage />
		</LanguageProvider>,
	);
	window.dispatchEvent(
		new StorageEvent("storage", { key: "amerged-sign-language", newValue: "en" }),
	);
	await waitFor(() => expect(screen.getByText("en")).toBeTruthy());
});
