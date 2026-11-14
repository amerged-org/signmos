// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
	type CompleteSigningPayload,
	PartnerSignatureForm,
	type PartnerSignaturePreference,
} from "./partner-signature-form";

describe("PartnerSignatureForm", () => {
	it("collects required, optional and repeated named fields without requiring a signature", async () => {
		const submissions: CompleteSigningPayload[] = [];
		const position = { page: 1, x: 20, y: 20, width: 120, height: 24 };
		render(
			<PartnerSignatureForm
				initialPreference={null}
				disabled={false}
				fields={[
					{ ...position, id: "name-1", type: "text", name: "name", label: "Name", required: true },
					{ ...position, id: "name-2", type: "text", name: "name", label: "Name", required: true },
					{ ...position, id: "date", type: "date", name: "date", label: "Datum", required: false },
					{
						...position,
						id: "accept",
						type: "checkbox",
						name: "accept",
						label: "Bestätigen",
						required: true,
					},
				]}
				onSubmit={async (payload) => {
					submissions.push(payload);
				}}
			/>,
		);

		expect(screen.getAllByLabelText("Name *")).toHaveLength(1);
		expect(screen.queryByLabelText("Dein vollständiger Name")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Abschließen" }));
		expect(submissions).toHaveLength(0);
		fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Ada" } });
		fireEvent.change(screen.getByLabelText("Datum (optional)"), {
			target: { value: "2026-11-13" },
		});
		fireEvent.click(screen.getByLabelText("Bestätigen *"));
		fireEvent.click(screen.getByRole("button", { name: "Abschließen" }));
		await waitFor(() => expect(submissions).toHaveLength(1));
		expect(submissions[0]).toEqual({
			fieldValues: { "name-1": "Ada", date: "2026-11-13", accept: true },
		});
	});

	it("allows an optional signature to be omitted or added", async () => {
		const submissions: CompleteSigningPayload[] = [];
		render(
			<PartnerSignatureForm
				initialPreference={null}
				disabled={false}
				fields={[
					{
						id: "sign",
						type: "signature",
						name: "sign",
						required: false,
						page: 1,
						x: 0,
						y: 0,
						width: 100,
						height: 30,
					},
				]}
				onSubmit={async (payload) => {
					submissions.push(payload);
				}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Abschließen" }));
		await waitFor(() => expect(submissions).toHaveLength(1));
		expect(submissions[0]).toEqual({});
		fireEvent.click(screen.getByLabelText("sign hinzufügen (optional)"));
		fireEvent.change(screen.getByLabelText("Dein vollständiger Name"), {
			target: { value: "Ada" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));
		await waitFor(() => expect(submissions).toHaveLength(2));
		expect(submissions[1]).toEqual({
			signature: { kind: "typed", typedText: "Ada", typedFont: "cursive" },
			rememberSignature: false,
			fieldValues: { sign: true },
		});
	});

	it("lets a signer select an optional signature independently from a required one", async () => {
		const submissions: CompleteSigningPayload[] = [];
		const position = { page: 1, x: 0, y: 0, width: 100, height: 30 };
		render(
			<PartnerSignatureForm
				initialPreference={null}
				disabled={false}
				fields={[
					{ ...position, id: "required-sign", type: "signature", name: "sign", required: true },
					{
						...position,
						id: "optional-sign",
						type: "signature",
						name: "initials",
						label: "Paraphe",
						required: false,
					},
					{
						...position,
						id: "optional-sign-repeat",
						type: "signature",
						name: "initials",
						label: "Paraphe",
						required: false,
					},
				]}
				onSubmit={async (payload) => {
					submissions.push(payload);
				}}
			/>,
		);
		expect(screen.getAllByLabelText("Paraphe hinzufügen (optional)")).toHaveLength(1);
		fireEvent.change(screen.getByLabelText("Dein vollständiger Name"), {
			target: { value: "Ada" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));
		await waitFor(() => expect(submissions).toHaveLength(1));
		expect(submissions[0]?.fieldValues).toBeUndefined();
		fireEvent.click(screen.getByLabelText("Paraphe hinzufügen (optional)"));
		fireEvent.click(screen.getByRole("button", { name: "Jetzt unterschreiben" }));
		await waitFor(() => expect(submissions).toHaveLength(2));
		expect(submissions[1]?.fieldValues).toEqual({ "optional-sign": true });
	});

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
		expect(screen.getByLabelText("Unterschrift merken")).toHaveProperty("checked", true);

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
		expect(screen.getByLabelText("Unterschrift merken")).toHaveProperty("checked", true);

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
