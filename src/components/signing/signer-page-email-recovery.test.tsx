// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SignerPage } from "./signer-page";

const session = {
	envelopeId: "00000000-0000-4000-8000-000000000001",
	recipientId: "20000000-0000-4000-8000-000000000001",
	sourceDocument: {
		version: 1,
		contentType: "application/pdf",
		downloadUrl: "/api/signing/valid-token/source-pdf",
	},
	fields: [
		{
			id: "signature-field",
			type: "signature",
			page: 1,
			x: 72,
			y: 144,
			width: 180,
			height: 48,
		},
		{
			id: "company-field",
			type: "text",
			label: "Firma",
			name: "company",
			required: true,
			page: 1,
			x: 72,
			y: 200,
			width: 180,
			height: 48,
		},
	],
	signaturePreference: null,
};

const mutationCases = [
	{ action: "complete", button: "Jetzt unterschreiben", success: "Angaben gespeichert." },
	{ action: "decline", button: "Ablehnen", success: "Abgelehnt." },
	{ action: "change-request", button: "Änderung anfragen", success: "Änderung angefragt." },
];

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it.each(
	mutationCases,
)("recovers $action after the email session expires while retaining entered values", async ({
	action,
	button,
	success,
}) => {
	let verified = false;
	const mutationAttempts: Array<RequestInit | undefined> = [];
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/email-code/request")) {
			return Response.json({
				data: { emailHint: "a•••@example.com", expiresInSeconds: 600, retryAfterSeconds: 60 },
			});
		}
		if (url.endsWith("/email-code/verify")) {
			verified = true;
			return Response.json({ data: { verified: true, signingUrl: "/signing/valid-token" } });
		}
		if (url.endsWith(`/${action}`)) {
			mutationAttempts.push(init);
			return verified
				? Response.json({ data: {} })
				: Response.json(
						{
							error: {
								code: "PARTNER_VERIFICATION_REQUIRED",
								message: "Enter the email code to open this document",
								emailHint: "a•••@example.com",
								verificationUrl: "/signing-verifications/valid-token",
							},
						},
						{ status: 403 },
					);
		}
		return Response.json({ data: session });
	});
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<SignerPage token="valid-token" />
		</QueryClientProvider>,
	);
	fireEvent.change(await screen.findByLabelText("Firma *"), {
		target: { value: "Example BV" },
	});
	fireEvent.change(screen.getByLabelText("Dein vollständiger Name"), {
		target: { value: "Ada Lovelace" },
	});
	fireEvent.click(screen.getByText("Weitere Optionen"));
	fireEvent.change(screen.getByLabelText("Änderung"), { target: { value: "Correct address" } });
	fireEvent.change(screen.getByLabelText("Grund"), { target: { value: "Wrong agreement" } });
	fireEvent.change(screen.getByLabelText("Kommentar"), { target: { value: "Please revise" } });
	fireEvent.click(screen.getByRole("button", { name: button }));

	fireEvent.click(await screen.findByRole("button", { name: "Code senden" }));
	expect(screen.getByText("a•••@example.com")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Jetzt unterschreiben" })).toBeNull();
	fireEvent.change(await screen.findByLabelText("6-stelliger Code"), {
		target: { value: "123456" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));

	await screen.findByRole("button", { name: "Jetzt unterschreiben" });
	expect(screen.getByLabelText("Firma *")).toHaveProperty("value", "Example BV");
	expect(screen.getByLabelText("Dein vollständiger Name")).toHaveProperty("value", "Ada Lovelace");
	expect(screen.getByLabelText("Änderung")).toHaveProperty("value", "Correct address");
	expect(screen.getByLabelText("Grund")).toHaveProperty("value", "Wrong agreement");
	expect(screen.getByLabelText("Kommentar")).toHaveProperty("value", "Please revise");
	expect(mutationAttempts).toHaveLength(1);
	fireEvent.click(screen.getByRole("button", { name: button }));
	await screen.findByText(success);
	await waitFor(() => expect(mutationAttempts).toHaveLength(2));
	expect(mutationAttempts[1]?.body).toBe(mutationAttempts[0]?.body);
});
