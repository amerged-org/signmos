// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { SignerPage } from "@/components/signing/signer-page";
import { LanguageProvider } from "@/lib/i18n";

const textFieldId = "30000000-0000-4000-8000-000000000001";
const signatureFieldId = "30000000-0000-4000-8000-000000000002";
const session = {
	envelopeId: "00000000-0000-4000-8000-000000000001",
	recipientId: "20000000-0000-4000-8000-000000000001",
	sourceDocument: { version: 1, contentType: "application/pdf", downloadUrl: "/synthetic.pdf" },
	fields: [
		{
			id: textFieldId,
			type: "text",
			name: "company",
			label: "Bedrijf",
			required: true,
			page: 1,
			x: 72,
			y: 144,
			width: 180,
			height: 48,
		},
		{
			id: signatureFieldId,
			type: "signature",
			name: "sign",
			label: "Handtekening",
			required: true,
			page: 1,
			x: 72,
			y: 220,
			width: 180,
			height: 48,
		},
	],
	signaturePreference: null,
};

function renderSigner() {
	return render(
		<LanguageProvider>
			<LanguageSwitcher />
			<SignerPage token="synthetic-token" />
		</LanguageProvider>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
	window.history.replaceState(null, "", "/");
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	window.localStorage.clear();
});

it("keeps entered field values and signature when changing languages", async () => {
	const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
		init?.method === "POST"
			? Response.json({ data: { recipientStatus: "completed" } })
			: Response.json({ data: session }),
	);
	vi.stubGlobal("fetch", fetcher);
	renderSigner();
	const company = await screen.findByLabelText("Bedrijf *");
	fireEvent.change(company, { target: { value: "Voorbeeld BV" } });
	fireEvent.change(screen.getByLabelText("Dein vollständiger Name"), {
		target: { value: "Alex Example" },
	});
	fireEvent.click(screen.getByRole("button", { name: "English" }));
	expect(screen.getByRole("heading", { name: "Sign the contract" })).toBeTruthy();
	expect(screen.getByLabelText("Bedrijf *")).toHaveProperty("value", "Voorbeeld BV");
	expect(screen.getByLabelText("Your full name")).toHaveProperty("value", "Alex Example");
	fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
	expect(screen.getByRole("heading", { name: "Contract ondertekenen" })).toBeTruthy();
	expect(screen.getByLabelText("Bedrijf *")).toHaveProperty("value", "Voorbeeld BV");
	expect(screen.getByLabelText("Je volledige naam")).toHaveProperty("value", "Alex Example");
	fireEvent.click(screen.getByRole("button", { name: "Nu ondertekenen" }));
	await waitFor(() =>
		expect(fetcher).toHaveBeenCalledWith(
			"/api/signing/synthetic-token/complete",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("Voorbeeld BV"),
			}),
		),
	);
	const completion = fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1];
	expect(JSON.parse(String(completion?.body))).toMatchObject({
		signature: { kind: "typed", typedText: "Alex Example" },
		fieldValues: { [textFieldId]: "Voorbeeld BV" },
	});
});

it("shows a localized expiry error instead of the server's message", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json(
				{ error: { code: "EXPIRED_TOKEN", message: "Internal server message" } },
				{ status: 410 },
			),
		),
	);
	renderSigner();
	fireEvent.click(screen.getByRole("button", { name: "Nederlands" }));
	await screen.findByText("Deze link is verlopen.");
	expect(screen.queryByText("Internal server message")).toBeNull();
});
