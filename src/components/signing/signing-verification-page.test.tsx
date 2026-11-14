// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LanguageProvider } from "@/lib/i18n";
import { SigningVerificationPage } from "./signing-verification-page";

function renderVerification(onVerified = vi.fn()) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<LanguageProvider>
				<SigningVerificationPage token="partner-token" onVerified={onVerified} />
			</LanguageProvider>
		</QueryClientProvider>,
	);
}

const inspection = {
	data: {
		status: "email_verification_required",
		emailHint: "a•••@example.com",
		signingLink: { token: "partner-token", url: "/signing/partner-token" },
	},
};

describe("SigningVerificationPage", () => {
	beforeEach(() => window.localStorage.clear());
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("requires an explicit code request before showing the code form", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === "POST"
				? Response.json({
						data: { emailHint: "a•••@example.com", expiresInSeconds: 600, retryAfterSeconds: 60 },
					})
				: Response.json(inspection),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onVerified = vi.fn();

		renderVerification(onVerified);

		await screen.findByText("a•••@example.com");
		expect(screen.queryByLabelText("6-stelliger Code")).toBeNull();
		expect(onVerified).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Code senden" }));

		const input = await screen.findByLabelText("6-stelliger Code");
		expect(input.getAttribute("inputmode")).toBe("numeric");
		expect(input.getAttribute("autocomplete")).toBe("one-time-code");
		expect(screen.getByText("Code gültig für 10:00.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Neuer Code in 60 s" })).toHaveProperty(
			"disabled",
			true,
		);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/api/signing/partner-token/email-code/request",
			expect.objectContaining({ method: "POST", body: "{}" }),
		);
		expect(onVerified).not.toHaveBeenCalled();
	});

	it("verifies only a six-digit code before continuing to the contract", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/verify")) {
				return Response.json({ data: { verified: true, signingUrl: "/signing/partner-token" } });
			}
			return init?.method === "POST"
				? Response.json({
						data: { emailHint: "a•••@example.com", expiresInSeconds: 600, retryAfterSeconds: 0 },
					})
				: Response.json(inspection);
		});
		vi.stubGlobal("fetch", fetchMock);
		const onVerified = vi.fn();
		renderVerification(onVerified);
		fireEvent.click(await screen.findByRole("button", { name: "Code senden" }));
		const code = await screen.findByLabelText("6-stelliger Code");
		fireEvent.change(code, { target: { value: "123" } });
		fireEvent.submit(code.closest("form") as HTMLFormElement);
		await screen.findByText("Bitte gib den 6-stelligen Code ein.");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		fireEvent.change(code, { target: { value: "123456" } });
		fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));

		await screen.findByText("E-Mail-Adresse bestätigt");
		await waitFor(() => expect(onVerified).toHaveBeenCalledWith("/signing/partner-token"));
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/api/signing/partner-token/email-code/verify",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "123456" }) }),
		);
	});

	it("shows expired-link errors without sending a code", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json(
				{ error: { code: "EXPIRED_TOKEN", message: "Internal detail" } },
				{ status: 410 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onVerified = vi.fn();
		renderVerification(onVerified);

		await screen.findByText("Dieser Link ist abgelaufen.");
		expect(screen.queryByRole("button", { name: "Code senden" })).toBeNull();
		expect(screen.queryByText("Internal detail")).toBeNull();
		expect(onVerified).not.toHaveBeenCalled();
	});
	it.each([
		["INVALID_EMAIL_CODE", "Code ungültig oder abgelaufen. Bitte neuen Code anfordern."],
		[
			"EMAIL_DELIVERY_UNAVAILABLE",
			"Der Code konnte nicht gesendet werden. Bitte später erneut versuchen.",
		],
		[
			"EMAIL_VERIFICATION_UNAVAILABLE",
			"E-Mail-Bestätigung ist gerade nicht verfügbar. Bitte später erneut versuchen.",
		],
	])("shows a useful localized error for %s", async (errorCode, message) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith("/verify")) {
					return Response.json(
						{ error: { code: errorCode, message: "Internal detail" } },
						{ status: 400 },
					);
				}
				return init?.method === "POST"
					? Response.json({
							data: { emailHint: "a•••@example.com", expiresInSeconds: 600, retryAfterSeconds: 0 },
						})
					: Response.json(inspection);
			}),
		);
		const onVerified = vi.fn();
		renderVerification(onVerified);
		fireEvent.click(await screen.findByRole("button", { name: "Code senden" }));
		fireEvent.change(await screen.findByLabelText("6-stelliger Code"), {
			target: { value: "123456" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));

		await screen.findByText(message);
		expect(screen.queryByText("Internal detail")).toBeNull();
		expect(screen.getByRole("button", { name: "Neuen Code senden" })).toHaveProperty(
			"disabled",
			false,
		);
		expect(onVerified).not.toHaveBeenCalled();
	});

	it("respects the server cooldown after a rate-limited code request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				init?.method === "POST"
					? Response.json(
							{
								error: {
									code: "EMAIL_CODE_RATE_LIMITED",
									message: "Internal detail",
									retryAfterSeconds: 30,
								},
							},
							{ status: 429, headers: { "Retry-After": "30" } },
						)
					: Response.json(inspection),
			),
		);
		renderVerification();
		fireEvent.click(await screen.findByRole("button", { name: "Code senden" }));

		await screen.findByText("Bitte warte kurz, bevor du einen neuen Code anforderst.");
		expect(screen.getByRole("button", { name: "Neuer Code in 30 s" })).toHaveProperty(
			"disabled",
			true,
		);
		expect(screen.queryByLabelText("6-stelliger Code")).toBeNull();
	});

	it("keeps the entered code when switching between German, English and Dutch", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === "POST"
				? Response.json({
						data: { emailHint: "a•••@example.com", expiresInSeconds: 600, retryAfterSeconds: 0 },
					})
				: Response.json(inspection),
		);
		vi.stubGlobal("fetch", fetchMock);
		renderVerification();
		fireEvent.click(await screen.findByRole("button", { name: "Code senden" }));
		fireEvent.change(await screen.findByLabelText("6-stelliger Code"), {
			target: { value: "123456" },
		});
		fireEvent.click(screen.getByRole("button", { name: "English" }));
		expect(screen.getByLabelText("6-digit code")).toHaveProperty("value", "123456");
		expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
		expect(screen.getByLabelText("6-cijferige code")).toHaveProperty("value", "123456");
		expect(screen.getByRole("button", { name: "Bevestigen" })).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("enables resend after the cooldown and disables an expired code", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				init?.method === "POST"
					? Response.json({
							data: { emailHint: "a•••@example.com", expiresInSeconds: 600, retryAfterSeconds: 60 },
						})
					: Response.json(inspection),
			),
		);
		renderVerification();
		fireEvent.click(await screen.findByRole("button", { name: "Code senden" }));
		await screen.findByLabelText("6-stelliger Code");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(screen.getByRole("button", { name: "Neuen Code senden" })).toHaveProperty(
			"disabled",
			false,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(540_000);
		});
		expect(screen.getByText("Der Code ist abgelaufen. Fordere einen neuen an.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Bestätigen" })).toHaveProperty("disabled", true);
	});
});
