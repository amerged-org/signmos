// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { SignerPage } from "@/components/signing/signer-page";

const envelopeId = "00000000-0000-4000-8000-000000000040";

describe("recovered signer accessibility", () => {
	it("renders tokenless review, signature, and alternate-action controls with native labels", async () => {
		// Issue #40 assumptions before RED:
		// - The shared signer component receives an envelope locator, never a bearer credential.
		// - Existing labelled controls stay keyboard-operable in recovered mode.
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							envelopeId,
							recipientId: "20000000-0000-4000-8000-000000000040",
							signingMode: "me_and_another_signer",
							sourceDocument: {
								version: 2,
								contentType: "application/pdf",
								downloadUrl: `/api/history/documents/${envelopeId}/signing/source-pdf`,
							},
							fields: [
								{
									id: "50000000-0000-4000-8000-000000000040",
									type: "signature",
									page: 1,
									x: 72,
									y: 144,
									width: 180,
									height: 48,
								},
							],
							previewFields: [],
							signaturePreference: null,
						},
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage historyEnvelopeId={envelopeId} />);

		expect(
			await screen.findByRole("heading", { name: "Vertrag prüfen und unterschreiben" }),
		).toBeTruthy();
		expect(screen.getByRole("link", { name: "PDF öffnen" }).getAttribute("href")).toBe(
			`/api/history/documents/${envelopeId}/signing/source-pdf`,
		);
		expect(screen.getByLabelText("Dein vollständiger Name")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Jetzt unterschreiben" })).toBeTruthy();
		expect(screen.getByLabelText("Gewünschte Änderung")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Änderung anfragen" })).toBeTruthy();
		expect(screen.getByLabelText("Grund für die Ablehnung")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Ablehnen" })).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(`/api/history/documents/${envelopeId}/signing`);
		expect(document.body.textContent).not.toContain("invitation-token");
	});

	it.each([
		["expired", "This document expired"],
		["declined", "This document was declined"],
		["deleted", "This document was deleted"],
	])("renders the %s terminal state without signing mutations", async (_state, message) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: { message } }), { status: 410 })),
		);
		render(<SignerPage historyEnvelopeId={envelopeId} />);

		expect(await screen.findByText(message)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Jetzt unterschreiben" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Änderung anfragen" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Ablehnen" })).toBeNull();
	});

	it("renders session-protected completion actions", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								completedDocument: {
									url: `/my-documents/${envelopeId}`,
									downloadUrl: `/api/history/documents/${envelopeId}/pdf`,
								},
							},
						}),
					),
			),
		);
		render(<SignerPage historyEnvelopeId={envelopeId} />);

		expect(await screen.findByText("Vertrag abgeschlossen")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Unterzeichneten Vertrag ansehen" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Unterzeichnete PDF herunterladen" })).toBeTruthy();
	});
});
