import { supportsPlaceholderText } from "./placeholder-font";

describe("supportsPlaceholderText", () => {
	it("accepts covered Unicode characters and rejects missing glyphs", () => {
		expect(supportsPlaceholderText("Jörg Müller — Καλημέρα")).toBe(true);
		expect(supportsPlaceholderText("🙂")).toBe(false);
	});
});
