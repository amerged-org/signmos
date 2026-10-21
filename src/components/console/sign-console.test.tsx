// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ApiAccess } from "./api-access";
import { SignConsole } from "./sign-console";

function response(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function renderConsole(component: ReactNode = <SignConsole />, client?: QueryClient) {
	const queryClient =
		client ??
		new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return {
		queryClient,
		...render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>),
	};
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("amerged Sign private console", () => {
	it("does not request or show contracts when session verification fails", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
			response({ error: { message: "Sitzung nicht verfügbar" } }, 503),
		);
		vi.stubGlobal("fetch", fetchMock);
		renderConsole();
		await screen.findByText("Anmeldung konnte nicht geprüft werden");
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/auth/session"]);
		expect(screen.queryByRole("button", { name: "Vertrag versenden" })).toBeNull();
	});

	it("hides private content immediately during logout and on a network error", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (input === "/api/auth/session")
				return response({
					data: { authenticated: true, email: "owner@example.com", csrfToken: "csrf-value" },
				});
			if (input === "/api/contracts")
				return response({
					data: [
						{
							id: "contract-1",
							title: "Privater Vertrag",
							status: "sent",
							recipients: [{ name: "Empfänger", email: "recipient@example.com", status: "sent" }],
							createdAt: "2026-10-21T12:00:00Z",
							completedAt: null,
							downloadUrl: null,
						},
					],
				});
			throw new TypeError("Verbindung unterbrochen");
		});
		vi.stubGlobal("fetch", fetchMock);
		renderConsole();
		await screen.findByText("Privater Vertrag");
		fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
		await screen.findByText("Abmeldung konnte nicht bestätigt werden");
		expect(screen.queryByText("Privater Vertrag")).toBeNull();
		expect(screen.queryByRole("tab", { name: "API & Verbindungen" })).toBeNull();
		expect(screen.getByRole("button", { name: "Abmeldung erneut versuchen" })).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/auth/logout",
			expect.objectContaining({
				method: "POST",
				headers: { "content-type": "application/json", "X-CSRF-Token": "csrf-value" },
			}),
		);
	});

	it("shows a generated API secret once and does not recover it after remount", async () => {
		const secret = "signmos_test-secret-only-once";
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === "POST"
				? response(
						{
							data: {
								secret,
								token: {
									id: "key-1",
									name: "Vertragsablage",
									hint: "signmos_…once",
									createdAt: "2026-10-21T12:00:00Z",
								},
							},
						},
						201,
					)
				: response({ data: [] }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const view = renderConsole(<ApiAccess csrfToken="csrf-value" />);
		await screen.findByText("Deine erste Verbindung beginnt hier.");
		fireEvent.change(screen.getByLabelText("Name der Verbindung"), {
			target: { value: "Vertragsablage" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Schlüssel erstellen" }));
		await screen.findByText(secret);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/auth/tokens",
			expect.objectContaining({
				headers: { "content-type": "application/json", "X-CSRF-Token": "csrf-value" },
				body: JSON.stringify({ name: "Vertragsablage" }),
			}),
		);
		view.unmount();
		renderConsole(<ApiAccess csrfToken="csrf-value" />, view.queryClient);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Schlüssel erstellen" })).toBeTruthy(),
		);
		expect(screen.queryByText(secret)).toBeNull();
		expect(window.localStorage.length).toBe(0);
		expect(window.sessionStorage.length).toBe(0);
	});
});
