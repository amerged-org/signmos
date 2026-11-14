// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewContract } from "@/components/console/new-contract";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { LanguageProvider } from "@/lib/i18n";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

it("keeps PDF bytes and recipient intact while changing the display language", async () => {
	const cookieWrite = vi.spyOn(document, "cookie", "set");
	const bytes = new Uint8Array([
		37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 128, 255, 10, 37, 37, 69, 79, 70,
	]);
	const fetcher = vi.fn(async () =>
		Response.json(
			{
				data: {
					id: "test",
					title: "agreement",
					status: "sent",
					recipients: [],
					createdAt: "2026-11-14T00:00:00Z",
				},
			},
			{ status: 201 },
		),
	);
	vi.stubGlobal("fetch", fetcher);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const onSent = vi.fn();
	render(
		<LanguageProvider>
			<LanguageSwitcher />
			<QueryClientProvider client={client}>
				<NewContract csrfToken="csrf" onSent={onSent} onCancel={vi.fn()} />
			</QueryClientProvider>
		</LanguageProvider>,
	);
	fireEvent.change(screen.getByLabelText("Vertrag als PDF"), {
		target: { files: [new File([bytes.buffer], "agreement.pdf", { type: "application/pdf" })] },
	});
	fireEvent.change(screen.getByLabelText("Vollständiger Name"), {
		target: { value: "Test Signer" },
	});
	fireEvent.change(screen.getByLabelText("E-Mail-Adresse"), {
		target: { value: "signer@example.invalid" },
	});
	fireEvent.click(screen.getByRole("button", { name: "English" }));
	expect(screen.getByLabelText("Full name")).toHaveProperty("value", "Test Signer");
	fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
	expect(screen.getByLabelText("Volledige naam")).toHaveProperty("value", "Test Signer");
	expect(screen.getByText("agreement.pdf")).toBeTruthy();
	expect(fetcher).not.toHaveBeenCalled();
	expect(cookieWrite).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Controleren" }));
	await screen.findByRole("dialog", { name: "Contract ter ondertekening versturen?" });
	expect(fetcher).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Nu versturen" }));
	await waitFor(() => expect(onSent).toHaveBeenCalledOnce());
	const call = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
	const payload = JSON.parse(String(call[1].body));
	expect(Object.keys(payload).sort()).toEqual(["pdf", "recipient", "title"]);
	expect(payload).toMatchObject({
		title: "agreement",
		recipient: { name: "Test Signer", email: "signer@example.invalid" },
		pdf: { filename: "agreement.pdf" },
	});
	expect(Uint8Array.from(atob(payload.pdf.base64), (character) => character.charCodeAt(0))).toEqual(
		bytes,
	);
});
