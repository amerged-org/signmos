import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist";
import {
	admin,
	deliveries,
	env,
	recipient,
	request,
	storedFileCount,
	useBrowserPdf,
} from "./contracts-crud-otp-test-fixture";

const html = "<!doctype html><h1>Rendered synthetic contract</h1><p>{{1.sign}}</p>";
function upload(content = html) {
	const form = new FormData();
	form.set("html", new Blob([content], { type: "text/html" }), "agreement.html");
	form.set(
		"definition",
		JSON.stringify({
			title: "Rendered synthetic contract",
			recipients: [{ index: 1, name: "Ada", email: recipient }],
			fields: [
				{ recipient: 1, name: "sign", type: "signature", label: "Signature", required: true },
			],
		}),
	);
	return form;
}
async function pdfBytes() {
	const pdf = await PDFDocument.create();
	const page = pdf.addPage([612, 792]);
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	page.drawText("Rendered synthetic contract", { x: 70, y: 740, size: 12, font });
	page.drawText("{{1.sign}}", { x: 70, y: 650, size: 12, font });
	return Uint8Array.from(await pdf.save()).buffer;
}

it("renders HTML once and delivers a signed PDF from those frozen source bytes", async () => {
	const bytes = await pdfBytes();
	const renderer = vi.fn(async (input: Request) => {
		expect(new URL(input.url).pathname).toBe("/pdf");
		expect(input.headers.get("authorization")).toBe(`Bearer ${env.OHMYHOST_BROWSER_KEY}`);
		expect(await input.json()).toEqual({ html });
		return new Response(bytes, { headers: { "content-type": "application/pdf" } });
	});
	useBrowserPdf(renderer);
	const create = (content = html) =>
		request("/api/contracts/drafts", admin("POST", "create-html", upload(content)));
	const draft = await create();
	expect(draft.status).toBe(201);
	const result = (await draft.json()) as { data: { id: string } };
	const { id } = result.data;
	expect(result).toMatchObject({ data: { definition: { pdf: { filename: "agreement.pdf" } } } });
	expect(await (await create()).json()).toEqual(result);
	expect((await create(`${html}<p>Changed</p>`)).status).toBe(409);
	expect(renderer).toHaveBeenCalledTimes(1);
	const send = await request(
		`/api/contracts/${id}/send`,
		admin("POST", "send-html", { delivery: "manual" }),
	);
	expect(send.status).toBe(200);
	const sent = (await send.json()) as { data: { signingLinks: Array<{ url: string }> } };
	const link = sent.data.signingLinks[0]?.url;
	if (!link) throw new Error("Expected personal signing link");
	const path = `/api/signing/${new URL(link).pathname.split("/").at(-1)}`;
	expect((await request(`${path}/source-pdf`)).status).toBe(403);
	const post = (suffix: string, body: unknown, cookie?: string) =>
		request(`${path}/${suffix}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			body: JSON.stringify(body),
		});
	expect((await post("email-code/request", {})).status).toBe(200);
	const code = [...deliveries.values()].at(-1)?.text.match(/\b\d{6}\b/u)?.[0];
	if (!code) throw new Error("Expected signer email code");
	const verified = await post("email-code/verify", { code });
	expect(verified.status).toBe(200);
	const cookie = verified.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error("Expected signer session");
	const frozen = await request(`${path}/source-pdf`, { headers: { cookie } });
	expect(await frozen.arrayBuffer()).toEqual(bytes);
	const signature = await post(
		"complete",
		{ signatureName: "Ada Lovelace", fieldValues: {} },
		cookie,
	);
	expect(await signature.json()).toMatchObject({ data: { envelopeStatus: "completed" } });
	const final = await request(`/api/contracts/${id}/pdf`, admin("GET", "html-final"));
	expect(final.status).toBe(200);
	const document = await getDocument({ data: new Uint8Array(await final.arrayBuffer()) }).promise;
	const page = await document.getPage(1);
	const contents = await page.getTextContent();
	expect(contents.items.map((item) => ("str" in item ? item.str : "")).join(" ")).toContain(
		"Rendered synthetic contract",
	);
	await document.destroy();
	expect(renderer).toHaveBeenCalledTimes(1);
}, 30_000);

it("queues create-and-send after saving the rendered PDF", async () => {
	const bytes = await pdfBytes();
	useBrowserPdf(async () => new Response(bytes));
	const response = await request("/api/contracts", admin("POST", "queue-html", upload()));
	expect(response.status).toBe(202);
	expect(await response.json()).toMatchObject({ data: { status: "queued" } });
	expect(storedFileCount()).toBe(1);
	expect(deliveries.size).toBe(0);
});

it("rejects oversized HTML and unauthorized requests before rendering", async () => {
	const renderer = vi.fn(async () => new Response(null));
	useBrowserPdf(renderer);
	const denied = await request("/api/contracts/drafts", { method: "POST", body: upload() });
	expect(denied.status).toBe(403);
	const tooLarge = await request(
		"/api/contracts/drafts",
		admin("POST", "large-html", upload("x".repeat(1024 * 1024 + 1))),
	);
	expect(tooLarge.status).toBe(413);
	expect(await tooLarge.json()).toMatchObject({ error: { code: "SOURCE_HTML_TOO_LARGE" } });
	expect(renderer).not.toHaveBeenCalled();
	expect(storedFileCount()).toBe(0);
});

it.each([
	[402, "HTML_RENDER_CREDITS_UNAVAILABLE", 503],
	[422, "INVALID_SOURCE_HTML", 400],
	[429, "HTML_RENDER_RATE_LIMITED", 503],
	[200, "HTML_RENDER_INVALID_PDF", 502],
] as const)("records an unsuccessful render (%s) without storing a PDF", async (status, code, mappedStatus) => {
	const renderer = vi.fn(async () => new Response("private upstream diagnostic", { status }));
	useBrowserPdf(renderer);
	const create = () => request("/api/contracts/drafts", admin("POST", "failed-html", upload()));
	const response = await create();
	expect(response.status).toBe(mappedStatus);
	const body = await response.text();
	expect(JSON.parse(body)).toMatchObject({ error: { code } });
	expect(body).not.toContain("private upstream diagnostic");
	expect(await (await create()).text()).toBe(body);
	expect(renderer).toHaveBeenCalledTimes(1);
	expect(storedFileCount()).toBe(0);
});
