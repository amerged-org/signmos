// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SignerPage } from "./signer-page";

describe("SignerPage", () => {
	it("shows a loading state while resolving the signing link", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

		render(<SignerPage token="valid-token" />);

		expect(screen.getByText("Vertrag wird geladen…")).toBeTruthy();
	});

	it("loads assigned fields and submits typed signing values", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "00000000-0000-4000-8000-000000000001",
							recipientId: "20000000-0000-4000-8000-000000000001",
							sourceDocument: {
								version: 1,
								contentType: "application/pdf",
								downloadUrl: "/api/signing/valid-token/source-pdf",
							},
							fields: [
								{
									id: "field-1",
									type: "signature",
									page: 1,
									x: 72,
									y: 144,
									width: 180,
									height: 48,
								},
								{ id: "field-2", type: "date", page: 1, x: 300, y: 144, width: 120, height: 32 },
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
							envelopeId: "00000000-0000-4000-8000-000000000001",
							recipientId: "20000000-0000-4000-8000-000000000001",
							sourceDocument: {
								version: 1,
								contentType: "application/pdf",
								downloadUrl: "/api/signing/valid-token/source-pdf",
							},
							fields: [],
							signaturePreference: null,
						},
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="valid-token" />);

		await screen.findByText("Unterschrift");
		expect(screen.getByRole("link", { name: "PDF öffnen" }).getAttribute("href")).toBe(
			"/api/signing/valid-token/source-pdf",
		);
		expect(screen.getByTitle("Vertragsvorschau").getAttribute("src")).toBe(
			"/api/signing/valid-token/source-pdf#toolbar=0&navpanes=0&scrollbar=0&page=1",
		);
		fireEvent.change(screen.getByLabelText("Dein vollständiger Name"), {
			target: { value: "Ada Lovelace" },
		});
		await waitFor(() =>
			expect(screen.getByLabelText("Dein vollständiger Name")).toHaveProperty(
				"value",
				"Ada Lovelace",
			),
		);
		expect(screen.queryByLabelText("Signing date")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"/api/signing/valid-token/complete",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					signature: {
						kind: "typed",
						typedText: "Ada Lovelace",
						typedFont: "cursive",
					},
					rememberSignature: false,
				}),
			}),
		);
	});

	it("overlays completed sender values and partner placeholders on the PDF preview", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					data: {
						envelopeId: "00000000-0000-4000-8000-000000000001",
						recipientId: "20000000-0000-4000-8000-000000000002",
						sourceDocument: {
							version: 1,
							contentType: "application/pdf",
							downloadUrl: "/api/signing/valid-token/source-pdf",
						},
						fields: [
							{
								id: "field-partner",
								type: "signature",
								page: 1,
								x: 72,
								y: 224,
								width: 180,
								height: 48,
							},
						],
						previewFields: [
							{
								id: "field-sender",
								recipientId: "20000000-0000-4000-8000-000000000001",
								recipientName: "Tomasz Kowalczyk",
								type: "signature",
								page: 1,
								x: 72,
								y: 144,
								width: 180,
								height: 48,
								value: "Tomasz Kowalczyk",
								assignedToCurrentSigner: false,
							},
							{
								id: "field-partner",
								recipientId: "20000000-0000-4000-8000-000000000002",
								recipientName: "Tom",
								type: "signature",
								page: 1,
								x: 72,
								y: 224,
								width: 180,
								height: 48,
								value: null,
								assignedToCurrentSigner: true,
							},
						],
						signaturePreference: null,
					},
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="valid-token" />);

		expect(
			(await screen.findByLabelText("Tomasz Kowalczyk · Unterschrift · ausgefüllt")).textContent,
		).toContain("Tomasz Kowalczyk");
		expect(screen.getByLabelText("Tom · Unterschrift · Feld").textContent).toContain(
			"Hier unterschreiben",
		);
	});

	it("allows switching between typed and drawn signatures while keeping saved-profile updates selected", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "00000000-0000-4000-8000-000000000001",
							recipientId: "20000000-0000-4000-8000-000000000001",
							sourceDocument: {
								version: 1,
								contentType: "application/pdf",
								downloadUrl: "/api/signing/valid-token/source-pdf",
							},
							fields: [
								{
									id: "field-1",
									type: "signature",
									page: 1,
									x: 72,
									y: 144,
									width: 180,
									height: 48,
								},
							],
							signaturePreference: {
								id: "60000000-0000-4000-8000-000000000001",
								envelopeId: "00000000-0000-4000-8000-000000000099",
								createdBy: "ada@example.com",
								kind: "typed",
								label: "Ada saved typed",
								svgPath: null,
								typedText: "Ada Saved",
								typedFont: "serif",
								selected: true,
								createdAt: "2026-05-20T09:00:00.000Z",
							},
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
							envelopeId: "00000000-0000-4000-8000-000000000001",
							recipientId: "20000000-0000-4000-8000-000000000001",
							sourceDocument: {
								version: 1,
								contentType: "application/pdf",
								downloadUrl: "/api/signing/valid-token/source-pdf",
							},
							fields: [],
							signaturePreference: null,
						},
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="valid-token" />);

		await screen.findByText("Unterschrift");
		expect(screen.getByLabelText("Dein vollständiger Name")).toHaveProperty("value", "Ada Saved");
		expect(screen.getByLabelText("Schriftstil")).toHaveProperty("value", "serif");
		const rememberCheckbox = screen.getByLabelText("Unterschrift für weitere Verträge merken");
		expect(rememberCheckbox).toHaveProperty("checked", true);

		fireEvent.click(screen.getByRole("button", { name: "Zeichnen wählen" }));
		expect(screen.getByLabelText("Unterschrift zeichnen")).toBeTruthy();
		expect(screen.queryByLabelText("Dein vollständiger Name")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Eintippen wählen" }));
		expect(screen.queryByLabelText("Signing date")).toBeNull();
		fireEvent.change(screen.getByLabelText("Dein vollständiger Name"), {
			target: { value: "Ada New" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"/api/signing/valid-token/complete",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					signature: {
						kind: "typed",
						typedText: "Ada New",
						typedFont: "serif",
					},
					rememberSignature: true,
				}),
			}),
		);
	});

	it("shows backend signing completion errors", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "00000000-0000-4000-8000-000000000001",
							recipientId: "20000000-0000-4000-8000-000000000001",
							sourceDocument: {
								version: 1,
								contentType: "application/pdf",
								downloadUrl: "/api/signing/valid-token/source-pdf",
							},
							fields: [
								{
									id: "field-1",
									type: "signature",
									page: 1,
									x: 72,
									y: 144,
									width: 180,
									height: 48,
								},
							],
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							code: "NO_ASSIGNED_FIELDS",
							message: "No signing fields are assigned to this recipient",
						},
					}),
					{ status: 409 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="valid-token" />);

		await screen.findByText("Unterschrift");
		fireEvent.change(screen.getByLabelText("Dein vollständiger Name"), {
			target: { value: "Ada Lovelace" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));

		await screen.findByText("No signing fields are assigned to this recipient");
	});

	it("submits a change request comment from the signer page", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: {
							envelopeId: "00000000-0000-4000-8000-000000000001",
							recipientId: "20000000-0000-4000-8000-000000000001",
							sourceDocument: {
								version: 1,
								contentType: "application/pdf",
								downloadUrl: "/api/signing/valid-token/source-pdf",
							},
							fields: [],
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="valid-token" />);

		await screen.findByRole("link", { name: "PDF öffnen" });
		expect(screen.getByText("Keine Unterschriftsfelder vorhanden")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Jetzt unterschreiben" })).toHaveProperty(
			"disabled",
			true,
		);
		fireEvent.change(screen.getByLabelText("Gewünschte Änderung"), {
			target: { value: "Please update the billing address." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Änderung anfragen" }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/api/signing/valid-token/change-request",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ comment: "Please update the billing address." }),
			}),
		);
		await screen.findByText("Änderungen wurden angefragt.");
		expect(screen.getByRole("button", { name: "Jetzt unterschreiben" })).toHaveProperty(
			"disabled",
			true,
		);
		expect(screen.getByRole("button", { name: "Änderung anfragen" })).toHaveProperty(
			"disabled",
			true,
		);
	});

	it("shows the partner verification link when signing access is blocked", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: {
						code: "PARTNER_VERIFICATION_REQUIRED",
						message: "Partner email verification is required before signing",
						verificationUrl: "/api/signing/verifications/valid-token",
					},
				}),
				{ status: 403 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="valid-token" />);

		await screen.findByText("Partner email verification is required before signing");
		expect(
			screen.getByRole("link", { name: "E-Mail-Adresse bestätigen" }).getAttribute("href"),
		).toBe("/api/signing/verifications/valid-token");
	});

	it("shows completed document links when a signing link is already complete", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					data: {
						completedDocument: {
							url: "/completed-documents/90000000-0000-4000-8000-000000000001",
							downloadUrl: "/api/final-documents/90000000-0000-4000-8000-000000000001/pdf",
						},
					},
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="valid-token" />);

		await screen.findByText("Vertrag abgeschlossen");
		expect(
			screen.getByRole("link", { name: "Unterzeichneten Vertrag ansehen" }).getAttribute("href"),
		).toBe("/completed-documents/90000000-0000-4000-8000-000000000001");
		expect(
			screen.getByRole("link", { name: "Unterzeichnete PDF herunterladen" }).getAttribute("href"),
		).toBe("/api/final-documents/90000000-0000-4000-8000-000000000001/pdf");
		expect(screen.queryByRole("button", { name: "Jetzt unterschreiben" })).toBeNull();
	});

	it("shows an expired signing-link message without signing controls", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: {
						code: "ENVELOPE_EXPIRED",
						message: "This signing link is no longer active",
					},
				}),
				{ status: 410 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="valid-token" />);

		await screen.findByText("This signing link is no longer active");
		expect(screen.queryByRole("button", { name: "Jetzt unterschreiben" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Änderung anfragen" })).toBeNull();
	});

	it("shows a deleted document message without PDF or signing controls", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: {
						code: "ENVELOPE_DELETED",
						message: "This document was deleted by the sender",
					},
				}),
				{ status: 410 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="valid-token" />);

		await screen.findByText("This document was deleted by the sender");
		expect(screen.queryByRole("link", { name: "PDF öffnen" })).toBeNull();
		expect(screen.queryByTitle("Vertragsvorschau")).toBeNull();
		expect(screen.queryByRole("button", { name: "Jetzt unterschreiben" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Änderung anfragen" })).toBeNull();
	});
});
