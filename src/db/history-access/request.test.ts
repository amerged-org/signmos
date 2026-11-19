import { buildHistoryAccessEmail } from "./request";

describe("history access request", () => {
	it("builds a metadata-free one-time access email", () => {
		const accessUrl = "https://signmos.example/history-access/raw-link";
		const email = buildHistoryAccessEmail({ email: "owner@example.com", accessUrl });
		const content = `${email.subject}\n${email.text}\n${email.html}`;

		expect(email.to).toBe("owner@example.com");
		expect(content).toContain(accessUrl);
		expect(content).toContain("30 minutes");
		expect(content).toContain("did not request");
		for (const forbiddenMetadata of [
			"contract.pdf",
			"Owner Example",
			"partner@example.com",
			"Completed",
			"1 document",
		]) {
			expect(content).not.toContain(forbiddenMetadata);
		}
	});

	it("escapes link characters in HTML while preserving the one-time link in text", () => {
		const accessUrl = 'https://signmos.example/history-access#credential=abc&next="unsafe"';
		const email = buildHistoryAccessEmail({ email: "owner@example.com", accessUrl });
		expect(email.text).toContain(accessUrl);
		expect(email.html).toContain("credential=abc&amp;next=&quot;unsafe&quot;");
		expect(email.html).not.toContain('next="unsafe"');
	});
});
