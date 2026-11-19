// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LanguageProvider, useLanguage } from "@/lib/i18n";
import { CompletedDocumentPage } from "./completed-document-page";

function renderPage(children: React.ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe("CompletedDocumentPage", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		// biome-ignore lint/suspicious/noDocumentCookie: Clear the browser preference created by this test.
		document.cookie = "amerged_sign_language=; Max-Age=0; Path=/";
		vi.unstubAllGlobals();
	});
	it("renders final PDF access, parties, signed dates, status, and public history", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: {
							token: "90000000-0000-4000-8000-000000000001",
							envelopeId: "00000000-0000-4000-8000-000000000001",
							status: "completed",
							finalPdf: {
								downloadUrl: "/api/final-documents/90000000-0000-4000-8000-000000000001/pdf",
								contentType: "application/pdf",
								byteSize: 32,
								sha256: "b".repeat(64),
								createdAt: "2026-05-21T09:11:00.000Z",
							},
							parties: [
								{
									id: "20000000-0000-4000-8000-000000000001",
									name: "Sender Example",
									email: "sender@example.com",
									status: "completed",
									signedDate: "2026-05-20",
									signedAt: "2026-05-20T07:06:00.000Z",
								},
								{
									id: "20000000-0000-4000-8000-000000000002",
									name: "Ada Lovelace",
									email: "ada@example.com",
									status: "completed",
									signedDate: "2026-05-21",
									signedAt: "2026-05-21T09:10:00.000Z",
								},
							],
							history: [
								{
									type: "sent",
									title: "Envelope sent",
									detail: "sender@example.com",
									occurredAt: "2026-05-20T07:04:00.000Z",
								},
								{
									type: "viewed",
									title: "Ada Lovelace viewed the document",
									detail: null,
									occurredAt: "2026-05-21T09:00:00.000Z",
								},
								{
									type: "signed",
									title: "Ada Lovelace signed",
									detail: "Ada Lovelace",
									occurredAt: "2026-05-21T09:10:00.000Z",
								},
							],
						},
					}),
					{ status: 200 },
				),
			),
		);

		renderPage(<CompletedDocumentPage token="90000000-0000-4000-8000-000000000001" />);

		await screen.findByText("Vertrag abgeschlossen");
		expect(screen.getByText("Unterzeichnet von")).toBeTruthy();
		expect(screen.getByRole("link", { name: "PDF herunterladen" }).getAttribute("href")).toBe(
			"/api/final-documents/90000000-0000-4000-8000-000000000001/pdf",
		);
		expect(screen.getByText("Sender Example")).toBeTruthy();
		expect(screen.getByText("sender@example.com")).toBeTruthy();
		expect(screen.getByText("Unterzeichnet · 2026-05-20")).toBeTruthy();
		expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
		expect(screen.getByText("ada@example.com")).toBeTruthy();
		expect(screen.getByText("Unterzeichnet · 2026-05-21")).toBeTruthy();
		expect(screen.getByText("Versendet")).toBeTruthy();
		expect(screen.getByText("Ada Lovelace hat das Dokument angesehen")).toBeTruthy();
		expect(screen.getByText("Ada Lovelace hat unterschrieben")).toBeTruthy();
		expect(screen.queryByText("partner.verified")).toBeNull();
	});

	it("switches the completed view between German, English and Dutch", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "test",
							status: "completed",
							finalPdf: { downloadUrl: "/download", byteSize: 10, sha256: "hash" },
							parties: [],
							history: [],
						},
					}),
					{ status: 200 },
				),
			),
		);
		function Switch() {
			const { setLanguage } = useLanguage();
			return (
				<>
					<button type="button" onClick={() => setLanguage("en")}>
						EN
					</button>
					<button type="button" onClick={() => setLanguage("nl")}>
						NL
					</button>
				</>
			);
		}
		renderPage(
			<LanguageProvider>
				<Switch />
				<CompletedDocumentPage token="test" />
			</LanguageProvider>,
		);
		const brand = screen.getByRole("link", { name: "amerged Sign Startseite" });
		expect(
			brand
				.closest("header")
				?.contains(screen.getByRole("navigation", { name: "Sprache / Language / Taal" })),
		).toBe(true);
		expect(screen.getAllByRole("navigation", { name: "Sprache / Language / Taal" })).toHaveLength(
			1,
		);
		await screen.findByRole("link", { name: "PDF herunterladen" });
		fireEvent.click(screen.getByRole("button", { name: "EN" }));
		expect(screen.getByRole("link", { name: "Download PDF" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "NL" }));
		expect(screen.getByRole("link", { name: "PDF downloaden" })).toBeTruthy();
	});
	it("verifies an email code before revealing the completed document", async () => {
		let verified = false;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/email-code/request")) {
				return Response.json({
					data: { emailHint: "a•••@example.com", expiresInSeconds: 600, retryAfterSeconds: 60 },
				});
			}
			if (url.endsWith("/email-code/verify")) {
				verified = true;
				return Response.json({ data: { verified: true, signingUrl: "/signing/final-token" } });
			}
			if (!verified) {
				return Response.json(
					{
						error: {
							code: "PARTNER_VERIFICATION_REQUIRED",
							emailHint: "a•••@example.com",
							verificationUrl: "/signing-verifications/final-token",
							message: "Internal message",
						},
					},
					{ status: 403 },
				);
			}
			return Response.json({
				data: {
					envelopeId: "fixture",
					status: "completed",
					finalPdf: {
						downloadUrl: "/api/final-documents/final-token/pdf",
						byteSize: 100,
						sha256: "hash",
					},
					parties: [],
					history: [],
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		renderPage(<CompletedDocumentPage token="final-token" />);

		fireEvent.click(await screen.findByRole("button", { name: "Code senden" }));
		expect(screen.queryByRole("link", { name: "PDF herunterladen" })).toBeNull();
		expect(screen.queryByText("Vertrag nicht verfügbar.")).toBeNull();
		fireEvent.change(await screen.findByLabelText("6-stelliger Code"), {
			target: { value: "123456" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));

		expect(
			(await screen.findByRole("link", { name: "PDF herunterladen" })).getAttribute("href"),
		).toBe("/api/final-documents/final-token/pdf");
		await waitFor(() =>
			expect(fetchMock).toHaveBeenLastCalledWith("/api/final-documents/final-token"),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/signing/final-token/email-code/verify",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "123456" }) }),
		);
	});
});
