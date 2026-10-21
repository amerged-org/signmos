// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { StartEnvelopePage } from "./start-envelope-page";

function renderStartEnvelopePage(props: ComponentProps<typeof StartEnvelopePage> = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<StartEnvelopePage {...props} />
		</QueryClientProvider>,
	);
}

describe("StartEnvelopePage", () => {
	beforeEach(() => {
		vi.stubGlobal("crypto", { randomUUID: () => "form-idempotency-key" });
	});

	it("starts with four equal task choices and reveals only the selected task", () => {
		// Issue #44 assumptions before RED:
		// - No task is selected when the landing page first renders.
		// - The four task labels are the stable public choice contract.
		// - Agentic mode uses dedicated credentials and never falls through to sender or My Documents.
		// - My documents asks for email only; request submission is tested in a later slice.
		// - Returning to the chooser removes task-specific form state from the visible UI.
		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });

		expect(screen.getByRole("button", { name: "Sign by myself" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign with someone else" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "My documents" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Agentic mode" })).toBeTruthy();
		expect(screen.queryByRole("form", { name: "Start envelope" })).toBeNull();
		expect(screen.queryByRole("form", { name: "Request My documents access" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "My documents" }));

		expect(screen.getByRole("form", { name: "Request My documents access" })).toBeTruthy();
		expect(screen.getByLabelText("Email")).toBeTruthy();
		expect(screen.queryByLabelText("Name")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Back to task choices" }));
		expect(screen.queryByRole("form", { name: "Request My documents access" })).toBeNull();
	});

	it.each([
		"Sign by myself",
		"Sign with someone else",
	])("returns to all four task choices after selecting %s", (choiceLabel) => {
		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });

		fireEvent.click(screen.getByRole("button", { name: choiceLabel }));
		expect(screen.getByRole("form", { name: "Start envelope" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Back to task choices" }));

		expect(screen.queryByRole("form", { name: "Start envelope" })).toBeNull();
		expect(screen.getByRole("button", { name: "Sign by myself" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign with someone else" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "My documents" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Agentic mode" })).toBeTruthy();
	});

	it.each([
		"Sign by myself",
		"Sign with someone else",
		"My documents",
		"Agentic mode",
	])("returns to the task chooser when browser history goes back from %s", (choiceLabel) => {
		// Browser-history assumptions before RED:
		// - Selecting any task from the chooser adds one same-page history entry.
		// - Popping back to the original entry restores the chooser without leaving `/`.
		// - Direct task links supplied through initialTask are intentionally unchanged.
		window.history.replaceState(null, "", "/");
		const initialHistoryLength = window.history.length;
		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });

		fireEvent.click(screen.getByRole("button", { name: choiceLabel }));
		expect(window.history.length).toBe(initialHistoryLength + 1);

		fireEvent.popState(window, { state: null });

		expect(
			screen.getByRole("heading", { level: 1, name: "Sign a PDF without an account" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign by myself" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign with someone else" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "My documents" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Agentic mode" })).toBeTruthy();
	});

	it.each([
		"Sign by myself",
		"Sign with someone else",
		"My documents",
		"Agentic mode",
	])("shows the task chooser return action first in the card for %s", (choiceLabel) => {
		// Assumptions for this UI consistency slice:
		// - All four tasks use the shared BackLink treatment (data-slot="back-link").
		// - All four tasks keep the same button name and chooser-reset behavior.
		// - Sign by myself establishes the intended top-of-card placement.
		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });

		fireEvent.click(screen.getByRole("button", { name: choiceLabel }));

		expect(screen.getByRole("navigation", { name: "Signmos options" })).toBeTruthy();
		expect(screen.getByRole("link", { name: choiceLabel }).getAttribute("aria-current")).toBe(
			"page",
		);
		const backButton = screen.getByRole("button", { name: "Back to task choices" });
		expect(backButton.getAttribute("data-slot")).toBe("back-link");
		expect(backButton.closest("form")?.firstElementChild).toBe(backButton);
	});

	it.each([
		{
			choiceLabel: "Sign by myself",
			heading: "Sign a PDF by yourself",
			description:
				"Enter your details, verify your email, then upload, prepare, and sign your document.",
		},
		{
			choiceLabel: "Sign with someone else",
			heading: "Sign a PDF with someone else",
			description:
				"Enter your details, verify your email, then upload your document and add the other signer.",
		},
		{
			choiceLabel: "My documents",
			heading: "Access your documents",
			description: "Enter your email to receive a secure link to view and manage your PDFs.",
		},
		{
			choiceLabel: "Agentic mode",
			heading: "Connect Signmos to an agent",
			description: "Verify your email to create and manage personal API tokens for your agent.",
		},
	])("shows task-specific hero copy for $choiceLabel", ({ choiceLabel, heading, description }) => {
		// Assumptions for this content slice:
		// - The amerged Sign brand link remains available for every selected task.
		// - The selected task controls both the main heading and its supporting sentence.
		// - Returning to the chooser continues to restore the generic landing copy.
		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });

		fireEvent.click(screen.getByRole("button", { name: choiceLabel }));

		expect(screen.getByRole("link", { name: "amerged Sign Startseite" })).toBeTruthy();
		expect(screen.getByRole("heading", { level: 1, name: heading })).toBeTruthy();
		expect(screen.getByText(description)).toBeTruthy();
	});

	it("requests My documents access with email only", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ data: { status: "accepted" } }), { status: 202 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });

		fireEvent.click(screen.getByRole("button", { name: "My documents" }));
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "owner@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Email me a secure link" }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith("/api/history/access-requests", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "form-idempotency-key",
			},
			body: JSON.stringify({ email: "owner@example.com", turnstileToken: "test-pass" }),
		});
		expect((await screen.findByRole("status")).textContent).toContain("Check your email");
		expect(screen.getByRole("button", { name: "Back to task choices" })).toBeTruthy();
	});

	it("requests dedicated Agentic access with email and Turnstile", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ data: { status: "accepted" } }), { status: 202 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });

		fireEvent.click(screen.getByRole("button", { name: "Agentic mode" }));
		expect(screen.getByRole("form", { name: "Request Agentic access" })).toBeTruthy();
		expect(screen.queryByLabelText("Name")).toBeNull();
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "Agent.User@Example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Email me an Agentic link" }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith("/api/agentic/access-requests", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "form-idempotency-key",
			},
			body: JSON.stringify({ email: "Agent.User@Example.com", turnstileToken: "test-pass" }),
		});
		expect((await screen.findByRole("status")).textContent).toContain("Check your email");
	});

	it("submits the selected partner-signing task through the existing sender-start contract", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "00000000-0000-4000-8000-000000000001",
							status: "awaiting_verification",
							signingMode: "me_and_another_signer",
							sender: {
								name: "Ada Lovelace",
								email: "ada@example.com",
							},
							allowedActions: ["verify_sender_email"],
							verification: {
								email: "ada@example.com",
								expiresAt: "2026-05-21T09:30:00.000Z",
							},
						},
					}),
					{ status: 201 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });
		fireEvent.click(screen.getByRole("button", { name: "Sign with someone else" }));

		const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
		const emailInput = screen.getByLabelText("Email") as HTMLInputElement;
		fireEvent.change(nameInput, { target: { value: "Ada Lovelace" } });
		fireEvent.change(emailInput, { target: { value: "ada@example.com" } });

		expect(nameInput.value).toBe("Ada Lovelace");
		expect(emailInput.value).toBe("ada@example.com");
		expect(screen.queryByRole("radio")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Start envelope" }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/envelopes/sender-start",
			expect.objectContaining({
				body: JSON.stringify({
					signingMode: "me_and_another_signer",
					name: "Ada Lovelace",
					email: "ada@example.com",
					turnstileToken: "test-pass",
				}),
			}),
		);
	});

	it("blocks sender start when Turnstile is not configured", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		renderStartEnvelopePage();
		fireEvent.click(screen.getByRole("button", { name: "Sign by myself" }));

		const alert = screen.getByRole("alert");
		const startButton = screen.getByRole("button", { name: "Start envelope" });

		expect(alert.textContent).toContain("Turnstile is not configured");
		expect((startButton as HTMLButtonElement).disabled).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("renders the Turnstile widget when the API is loaded", async () => {
		const renderTurnstile = vi.fn((container: HTMLElement) => {
			const iframe = document.createElement("iframe");
			iframe.title = "Turnstile challenge";
			container.appendChild(iframe);
			return "widget-id";
		});
		vi.stubGlobal("turnstile", { render: renderTurnstile });

		renderStartEnvelopePage({ turnstileSiteKey: "site-key" });
		fireEvent.click(screen.getByRole("button", { name: "Sign by myself" }));

		await waitFor(() =>
			expect(renderTurnstile).toHaveBeenCalledWith(expect.any(HTMLElement), {
				sitekey: "site-key",
			}),
		);
		expect(screen.getByTitle("Turnstile challenge")).toBeTruthy();
	});

	it("requires a completed Turnstile challenge when the widget has no response", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		renderStartEnvelopePage({ turnstileSiteKey: "site-key" });
		fireEvent.click(screen.getByRole("button", { name: "Sign by myself" }));

		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Lovelace" } });
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
		fireEvent.click(screen.getByRole("button", { name: "Start envelope" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Complete the Turnstile challenge");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("submits the completed Turnstile widget response", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "00000000-0000-4000-8000-000000000001",
							status: "awaiting_verification",
							sender: {
								name: "Ada Lovelace",
								email: "ada@example.com",
							},
							verification: {
								email: "ada@example.com",
								expiresAt: "2026-05-21T09:30:00.000Z",
							},
						},
					}),
					{ status: 201 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		renderStartEnvelopePage({ turnstileSiteKey: "site-key" });
		fireEvent.click(screen.getByRole("button", { name: "Sign by myself" }));

		const widgetResponse = document.createElement("input");
		widgetResponse.type = "hidden";
		widgetResponse.name = "cf-turnstile-response";
		widgetResponse.value = "widget-pass";
		screen.getByRole("form", { name: "Start envelope" }).appendChild(widgetResponse);

		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Lovelace" } });
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
		fireEvent.click(screen.getByRole("button", { name: "Start envelope" }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/envelopes/sender-start",
			expect.objectContaining({
				body: JSON.stringify({
					signingMode: "only_me",
					name: "Ada Lovelace",
					email: "ada@example.com",
					turnstileToken: "widget-pass",
				}),
			}),
		);
	});

	it("submits sender details and shows sent-email confirmation without a verification link", async () => {
		// Assumptions for issue #23:
		// - The normal sender-start UI is not a developer/debug surface.
		// - The API may create a fallback URL for email records, but normal UI must not render it.
		// - Turnstile test bypass remains explicit through this component prop and route env.
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "00000000-0000-4000-8000-000000000001",
							status: "awaiting_verification",
							sender: {
								name: "Ada Lovelace",
								email: "ada@example.com",
							},
							allowedActions: ["verify_sender_email"],
							verification: {
								email: "ada@example.com",
								expiresAt: "2026-05-21T09:30:00.000Z",
								fallbackUrl: "http://localhost/sender-verifications/sender-token",
							},
						},
					}),
					{ status: 201 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });
		fireEvent.click(screen.getByRole("button", { name: "Sign by myself" }));

		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Lovelace" } });
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
		fireEvent.click(screen.getByRole("button", { name: "Start envelope" }));

		await screen.findByText("Check your email");
		expect(screen.getByText("Verification was sent to ada@example.com.")).toBeTruthy();
		expect(screen.queryByRole("link", { name: /verification/i })).toBeNull();
		expect(document.body.textContent).not.toContain("http://localhost/sender-verifications");
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/envelopes/sender-start",
			expect.objectContaining({
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "form-idempotency-key",
				},
				body: JSON.stringify({
					signingMode: "only_me",
					name: "Ada Lovelace",
					email: "ada@example.com",
					turnstileToken: "test-pass",
				}),
			}),
		);
	});

	it("shows start errors next to the form action", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: {
								code: "TURNSTILE_FAILED",
								message: "Turnstile verification failed",
							},
						}),
						{ status: 403 },
					),
			),
		);

		renderStartEnvelopePage({ testTurnstileToken: "invalid" });
		fireEvent.click(screen.getByRole("button", { name: "Sign by myself" }));

		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Lovelace" } });
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
		fireEvent.click(screen.getByRole("button", { name: "Start envelope" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Turnstile verification failed");
	});

	it("recovers from non-JSON server failures without leaving the form submitting", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Internal Server Error", { status: 500 })),
		);

		renderStartEnvelopePage({ testTurnstileToken: "test-pass" });
		fireEvent.click(screen.getByRole("button", { name: "Sign by myself" }));

		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Lovelace" } });
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
		fireEvent.click(screen.getByRole("button", { name: "Start envelope" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Unable to start the envelope");
		expect(screen.getByRole("button", { name: "Start envelope" })).toBeTruthy();
	});
});
