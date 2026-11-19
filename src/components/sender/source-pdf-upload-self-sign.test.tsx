// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { SourcePdfUploadPanel } from "./source-pdf-upload-panel";

describe("SourcePdfUploadPanel self-sign mode", () => {
	beforeEach(() => {
		vi.stubGlobal("crypto", { randomUUID: () => "upload-idempotency-key" });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows a PDF preview and direct signing link after a single-signer upload", async () => {
		const file = new File([new TextEncoder().encode("%PDF-1.7\n%")], "contract.pdf", {
			type: "application/pdf",
		});
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			if (
				url === "/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf" &&
				init?.method === "POST"
			) {
				return sourcePdfResponse({
					selfSign: {
						recipientId: "20000000-0000-4000-8000-000000000001",
						signingUrl: "/signing/self-sign-token",
						fieldCount: 2,
						fieldPage: 3,
					},
				});
			}
			if (url === "/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf") {
				return sourcePdfMissingResponse();
			}
			throw new Error(`Unexpected fetch ${String(url)} ${init?.method ?? "GET"}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		renderWithQueryClient(
			<SourcePdfUploadPanel
				envelopeId="00000000-0000-4000-8000-000000000001"
				senderSessionToken="verified-sender-token"
				signingMode="only_me"
				senderName="Ada Lovelace"
				senderEmail="ada@example.com"
			/>,
		);

		fireEvent.change(screen.getByLabelText("Choose PDF"), { target: { files: [file] } });
		fireEvent.click(screen.getByRole("button", { name: "Upload selected PDF" }));

		const preview = await screen.findByTitle("Uploaded source PDF preview");
		expect(preview.getAttribute("src")).toBe(
			"/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf/content?senderSessionToken=verified-sender-token#toolbar=0&navpanes=0&scrollbar=0&page=3",
		);
		expect(screen.getByRole("link", { name: "Continue to sign" }).getAttribute("href")).toBe(
			"/signing/self-sign-token",
		);
		expect(screen.queryByRole("form", { name: "Add recipients" })).toBeNull();
		expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
	});

	it("shows actionable over-limit upload copy from the API", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				if (
					url === "/api/envelopes/00000000-0000-4000-8000-000000000001/source-pdf" &&
					init?.method !== "POST"
				) {
					return sourcePdfMissingResponse();
				}
				return new Response(
					JSON.stringify({
						error: {
							code: "SOURCE_PDF_TOO_LARGE",
							message: "Source PDF must be at most 2 MiB",
						},
					}),
					{ status: 413 },
				);
			}),
		);

		renderWithQueryClient(
			<SourcePdfUploadPanel
				envelopeId="00000000-0000-4000-8000-000000000001"
				senderSessionToken="verified-sender-token"
				senderName="Ada Lovelace"
				senderEmail="ada@example.com"
			/>,
		);

		const file = new File([new TextEncoder().encode("%PDF-1.7\n%")], "contract.pdf", {
			type: "application/pdf",
		});
		fireEvent.change(screen.getByLabelText("Choose PDF"), { target: { files: [file] } });
		fireEvent.click(screen.getByRole("button", { name: "Upload selected PDF" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Source PDF must be at most 2 MiB");
	});
});

function sourcePdfResponse({
	selfSign,
}: {
	selfSign: {
		recipientId: string;
		signingUrl: string;
		fieldCount: number;
		fieldPage: number;
	};
}) {
	return new Response(
		JSON.stringify({
			data: {
				id: "10000000-0000-4000-8000-000000000001",
				envelopeId: "00000000-0000-4000-8000-000000000001",
				r2Key: "envelopes/00000000-0000-4000-8000-000000000001/source-v1.pdf",
				version: 1,
				sha256: "a".repeat(64),
				byteSize: 10,
				contentType: "application/pdf",
				uploadedBy: "ada@example.com",
				uploadedAt: "2026-05-21T09:10:00.000Z",
				selfSign,
			},
		}),
		{ status: 201 },
	);
}

function sourcePdfMissingResponse() {
	return new Response(
		JSON.stringify({
			error: {
				code: "SOURCE_PDF_NOT_FOUND",
				message: "Upload a source PDF before preparing or sending this envelope",
			},
		}),
		{ status: 404 },
	);
}

function renderWithQueryClient(ui: ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}
