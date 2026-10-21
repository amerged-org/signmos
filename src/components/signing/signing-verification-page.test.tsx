// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { SigningVerificationPage } from "./signing-verification-page";

describe("SigningVerificationPage", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("verifies the partner token and redirects to the signing UI", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "00000000-0000-4000-8000-000000000001",
							recipientId: "20000000-0000-4000-8000-000000000002",
							status: "verified",
							signingLink: {
								token: "partner-token",
								url: "/signing/partner-token",
							},
							verifiedAt: "2026-05-21T09:05:00.000Z",
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onVerified = vi.fn();

		render(<SigningVerificationPage token="partner-token" onVerified={onVerified} />);

		await screen.findByText("E-Mail-Adresse bestätigt");
		expect(screen.getByRole("link", { name: "Zum Vertrag" }).getAttribute("href")).toBe(
			"/signing/partner-token",
		);
		await waitFor(() => expect(onVerified).toHaveBeenCalledWith("/signing/partner-token"));
		expect(fetchMock).toHaveBeenCalledWith("/api/signing/verifications/partner-token");
	});

	it("shows verification errors without redirecting", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: {
								code: "EXPIRED_PARTNER_VERIFICATION",
								message: "Partner verification token has expired",
							},
						}),
						{ status: 410 },
					),
			),
		);
		const onVerified = vi.fn();

		render(<SigningVerificationPage token="expired-token" onVerified={onVerified} />);

		await screen.findByText("Bestätigung nicht möglich");
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Partner verification token has expired");
		expect(onVerified).not.toHaveBeenCalled();
	});
});
