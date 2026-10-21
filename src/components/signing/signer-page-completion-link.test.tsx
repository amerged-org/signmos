// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SignerPage } from "./signer-page";

describe("SignerPage completion detail link", () => {
	it("shows completed document actions immediately after self-sign completion", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "00000000-0000-4000-8000-000000000001",
							recipientId: "20000000-0000-4000-8000-000000000001",
							signingMode: "only_me",
							sourceDocument: {
								version: 1,
								contentType: "application/pdf",
								downloadUrl: "/api/signing/self-sign-token/source-pdf",
							},
							fields: [
								{
									id: "field-1",
									type: "signature",
									page: 1,
									x: 360,
									y: 628,
									width: 180,
									height: 48,
								},
							],
							signaturePreference: null,
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: {
							completedDocument: {
								url: "/completed-documents/self-sign-token",
								downloadUrl: "/api/final-documents/self-sign-token/pdf",
							},
						},
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="self-sign-token" />);

		await screen.findByText("Unterschrift");
		fireEvent.change(screen.getByLabelText("Dein vollständiger Name"), {
			target: { value: "Ada Self Sign" },
		});
		await waitFor(() =>
			expect(screen.getByLabelText("Dein vollständiger Name")).toHaveProperty(
				"value",
				"Ada Self Sign",
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));

		await screen.findByText("Vertrag abgeschlossen");
		expect(
			screen.getByRole("link", { name: "Unterzeichneten Vertrag ansehen" }).getAttribute("href"),
		).toBe("/completed-documents/self-sign-token");
		expect(
			screen.getByRole("link", { name: "Unterzeichnete PDF herunterladen" }).getAttribute("href"),
		).toBe("/api/final-documents/self-sign-token/pdf");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
