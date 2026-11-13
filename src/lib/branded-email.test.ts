import { renderBrandedEmail } from "./branded-email";

describe("amerged Sign email layout", () => {
	it("renders the brand and a direct action while escaping user-supplied content", () => {
		const html = renderBrandedEmail({
			eyebrow: "VERTRAG",
			title: "Ein Vertrag wartet",
			paragraphs: ["Hallo <Ada & Grace>,"],
			details: [{ label: "KOMMENTAR", value: "Bitte <prüfen>\nDanke" }],
			action: {
				label: "Vertrag öffnen",
				url: "https://sign.example.test/sign#credential=secret&part=two",
			},
			note: "Der Link ist 7 Tage gültig.",
		});
		expect(html).toContain("https://amerged.com/brand/assets/amerged-logo-email.png");
		expect(html).toContain("#b12c2b");
		expect(html).toContain("#171717");
		expect(html).toContain("Hallo &lt;Ada &amp; Grace&gt;,");
		expect(html).toContain("Bitte &lt;prüfen&gt;<br>Danke");
		expect(html).toContain('href="https://sign.example.test/sign#credential=secret&amp;part=two"');
		expect(html).not.toContain("<Ada");
	});

	it("refuses non-web action URLs", () => {
		expect(() =>
			renderBrandedEmail({
				eyebrow: "TEST",
				title: "Test",
				paragraphs: [],
				action: { label: "Open", url: "javascript:alert(1)" },
			}),
		).toThrow("Email action URL must use HTTP or HTTPS");
	});
});
