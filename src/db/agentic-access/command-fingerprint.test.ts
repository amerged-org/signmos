import { fingerprintAgentCommand } from "./command-authority";

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("agent command fingerprint", () => {
	it("ignores key order and canonicalizes by code unit, not by locale", async () => {
		// "B" (66) sorts before "a" (97) by code unit; a locale collator would put "a" first.
		const canonical = await sha256('{"B":1,"a":{"x":[3,{"Y":1,"b":2}],"y":null}}');
		expect(await fingerprintAgentCommand({ a: { y: null, x: [3, { b: 2, Y: 1 }] }, B: 1 })).toBe(
			canonical,
		);
		expect(await fingerprintAgentCommand({ B: 1, a: { x: [3, { Y: 1, b: 2 }], y: null } })).toBe(
			canonical,
		);
	});

	it("never initializes the locale collator, which costs CPU on a cold Worker isolate", async () => {
		const collator = vi.spyOn(String.prototype, "localeCompare");
		try {
			await fingerprintAgentCommand({ title: "Vertrag", recipient: { name: "Ada" }, pdf: {} });
			expect(collator).not.toHaveBeenCalled();
		} finally {
			collator.mockRestore();
		}
	});
});
