// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
	type CompleteSigningPayload,
	PartnerSignatureForm,
	type PartnerSignaturePreference,
} from "./partner-signature-form";

describe("PartnerSignatureForm", () => {
	it("prefills a saved typed signature and keeps future updates selected", async () => {
		const submissions: CompleteSigningPayload[] = [];

		render(
			<PartnerSignatureForm
				initialPreference={savedTypedPreference}
				disabled={false}
				onSubmit={async (payload) => {
					submissions.push(payload);
				}}
			/>,
		);

		expect(screen.getByLabelText("Dein vollständiger Name")).toHaveProperty("value", "Ada Saved");
		expect(screen.getByLabelText("Schriftstil")).toHaveProperty("value", "serif");
		expect(screen.getByLabelText("Unterschrift für weitere Verträge merken")).toHaveProperty(
			"checked",
			true,
		);

		fireEvent.change(screen.getByLabelText("Dein vollständiger Name"), {
			target: { value: "Ada Updated" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));

		await waitFor(() => expect(submissions).toHaveLength(1));
		expect(submissions[0]).toEqual({
			signature: {
				kind: "typed",
				typedText: "Ada Updated",
				typedFont: "serif",
			},
			rememberSignature: true,
		});
	});

	it("prefills a saved drawn signature path and submits it as the preferred mode", async () => {
		const submissions: CompleteSigningPayload[] = [];

		render(
			<PartnerSignatureForm
				initialPreference={savedDrawnPreference}
				disabled={false}
				onSubmit={async (payload) => {
					submissions.push(payload);
				}}
			/>,
		);

		expect(screen.getByRole("button", { name: "Zeichnen wählen" })).toHaveProperty(
			"ariaPressed",
			"true",
		);
		expect(
			screen.getByLabelText("Unterschrift zeichnen").querySelector("path")?.getAttribute("d"),
		).toBe("M 12 36 L 48 20 L 96 42");
		expect(screen.getByLabelText("Unterschrift für weitere Verträge merken")).toHaveProperty(
			"checked",
			true,
		);

		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));

		await waitFor(() => expect(submissions).toHaveLength(1));
		expect(submissions[0]).toEqual({
			signature: {
				kind: "drawn",
				label: "Drawn signature",
				svgPath: "M 12 36 L 48 20 L 96 42",
			},
			rememberSignature: true,
		});
	});

	it("captures a drawn signature stroke and submits its SVG path", async () => {
		const submissions: CompleteSigningPayload[] = [];

		render(
			<PartnerSignatureForm
				initialPreference={null}
				disabled={false}
				onSubmit={async (payload) => {
					submissions.push(payload);
				}}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Zeichnen wählen" }));
		const signaturePad = screen.getByLabelText("Unterschrift zeichnen");
		Object.defineProperty(signaturePad, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				bottom: 128,
				height: 128,
				left: 0,
				right: 320,
				top: 0,
				width: 320,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}),
		});

		fireEvent.mouseDown(signaturePad, { clientX: 12, clientY: 36 });
		fireEvent.mouseMove(signaturePad, { clientX: 48, clientY: 20 });
		fireEvent.mouseUp(signaturePad);
		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));

		await waitFor(() => expect(submissions).toHaveLength(1));
		expect(submissions[0]).toEqual({
			signature: {
				kind: "drawn",
				label: "Drawn signature",
				svgPath: "M 12 36 L 48 20",
			},
			rememberSignature: false,
		});
	});
});

const savedTypedPreference: PartnerSignaturePreference = {
	id: "60000000-0000-4000-8000-000000000001",
	kind: "typed",
	label: "Saved typed",
	svgPath: null,
	typedText: "Ada Saved",
	typedFont: "serif",
};

const savedDrawnPreference: PartnerSignaturePreference = {
	id: "60000000-0000-4000-8000-000000000002",
	kind: "drawn",
	label: "Saved drawn",
	svgPath: "M 12 36 L 48 20 L 96 42",
	typedText: null,
	typedFont: null,
};
