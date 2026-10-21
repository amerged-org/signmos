// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SignerPage } from "./signer-page";

describe("SignerPage self-sign mode", () => {
	it("hides partner-only change and decline actions", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
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
								x: 72,
								y: 144,
								width: 180,
								height: 48,
							},
						],
						signaturePreference: null,
					},
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="self-sign-token" />);

		await screen.findByRole("button", { name: "Jetzt unterschreiben" });
		expect(screen.queryByLabelText("Gewünschte Änderung")).toBeNull();
		expect(screen.queryByRole("button", { name: "Änderung anfragen" })).toBeNull();
		expect(screen.queryByLabelText("Grund für die Ablehnung")).toBeNull();
		expect(screen.queryByLabelText("Kommentar")).toBeNull();
		expect(screen.queryByRole("button", { name: "Ablehnen" })).toBeNull();
	});

	it("drags signature and date placeholders on the PDF preview", async () => {
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
									id: "50000000-0000-4000-8000-000000000001",
									type: "signature",
									page: 1,
									x: 72,
									y: 144,
									width: 180,
									height: 48,
								},
								{
									id: "50000000-0000-4000-8000-000000000002",
									type: "date",
									page: 1,
									x: 300,
									y: 144,
									width: 120,
									height: 32,
								},
							],
							signaturePreference: null,
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		render(<SignerPage token="self-sign-token" />);

		const page = await screen.findByLabelText("Vertrag Seite 1");
		vi.spyOn(page, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 306,
			bottom: 396,
			width: 306,
			height: 396,
			toJSON: () => ({}),
		});
		fireEvent.mouseDown(screen.getByLabelText("Unterzeichner · Unterschrift · Feld"), {
			clientX: 36,
			clientY: 72,
		});
		fireEvent.mouseMove(page, { clientX: 48, clientY: 96 });
		fireEvent.mouseUp(page);

		fireEvent.mouseDown(screen.getByLabelText("Unterzeichner · Datum · Feld"), {
			clientX: 150,
			clientY: 72,
		});
		fireEvent.mouseMove(page, { clientX: 156, clientY: 102 });
		fireEvent.mouseUp(page);

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"/api/signing/self-sign-token/fields/50000000-0000-4000-8000-000000000001",
			expect.objectContaining({
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ page: 1, x: 96, y: 192 }),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			3,
			"/api/signing/self-sign-token/fields/50000000-0000-4000-8000-000000000002",
			expect.objectContaining({
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ page: 1, x: 312, y: 204 }),
			}),
		);
	});
});
