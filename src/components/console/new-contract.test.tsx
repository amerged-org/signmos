// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewContract } from "./new-contract";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("contract send form", () => {
	it("requires a reviewed send and reuses the same command after a connection failure", async () => {
		const onSent = vi.fn();
		const row = {
			id: "contract-id",
			title: "vertrag",
			status: "sent",
			recipients: [{ name: "Erika Musterfrau", email: "erika@example.com", status: "sent" }],
			createdAt: "2026-10-21T12:00:00.000Z",
			completedAt: null,
			downloadUrl: null,
		};
		let attempt = 0;
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
			attempt += 1;
			if (attempt === 1) throw new TypeError("Verbindung unterbrochen");
			return new Response(JSON.stringify({ data: row }), { status: 201 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<NewContract csrfToken="csrf-value" onSent={onSent} onCancel={vi.fn()} />
			</QueryClientProvider>,
		);
		fireEvent.change(screen.getByLabelText("Vertrag als PDF"), {
			target: {
				files: [new File(["%PDF-1.7\nfixture"], "vertrag.pdf", { type: "application/pdf" })],
			},
		});
		fireEvent.change(screen.getByLabelText("Vollständiger Name"), {
			target: { value: "Erika Musterfrau" },
		});
		fireEvent.change(screen.getByLabelText("E-Mail-Adresse"), {
			target: { value: "erika@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Versand prüfen" }));
		await screen.findByRole("dialog", { name: "Vertrag zur Unterschrift senden?" });
		expect(fetchMock).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Jetzt versenden" }));
		await screen.findByText("Versand nicht abgeschlossen");
		expect(onSent).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Jetzt versenden" }));
		await waitFor(() => expect(onSent).toHaveBeenCalledWith(row));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = fetchMock.mock.calls[0]?.[1];
		const second = fetchMock.mock.calls[1]?.[1];
		expect(first?.body).toBe(second?.body);
		expect(first?.headers).toEqual(second?.headers);
		const headers = new Headers(first?.headers);
		expect(headers.get("x-csrf-token")).toBe("csrf-value");
		expect(headers.get("idempotency-key")).toMatch(/^[\da-f-]{36}$/);
		expect(JSON.parse(String(first?.body))).toEqual({
			title: "vertrag",
			recipient: { name: "Erika Musterfrau", email: "erika@example.com" },
			pdf: { filename: "vertrag.pdf", base64: btoa("%PDF-1.7\nfixture") },
		});
	});
});
