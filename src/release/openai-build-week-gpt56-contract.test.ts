import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const evidencePath = "plans/evidence/openai-build-week-gpt56.md";

/**
 * Issue #59 assumptions:
 * - Public evidence records a privacy-safe fingerprint of the retained private
 *   Codex ledger; it never publishes the session ID, raw prompts, or transcript.
 * - Meaningful use is evidenced by the primary build thread and concrete
 *   qualifying commits, not by adding a prose claim after the work.
 * - Repository copy and timestamped narration are canonical inputs for the
 *   external Devpost/video artifacts, whose publication is verified by #54/#60.
 * - GPT-5.6 was a build-time Codex model, not a Signmos runtime dependency.
 */
describe("OpenAI Build Week GPT-5.6 evidence contract", () => {
	it("retains the private model-evidence fingerprint and qualifying commit map", () => {
		const evidence = read(evidencePath);

		for (const phrase of [
			"2026-07-17T14:19:48.391Z",
			"2026-07-18T16:55:55.434Z",
			"46 model-context records",
			"gpt-5.6-sol",
			"f84fca42d65c1ab76f12ff9a3e44dd251ab97939d58b0e417bc78d1f4005ad63",
		]) {
			expect(evidence, phrase).toContain(phrase);
		}

		for (const commit of [
			"f396721",
			"116a96f",
			"a60b780",
			"005dde6",
			"46f2b2c",
			"db3ed74",
			"6343f1e",
			"bd75576",
			"9183acc",
			"fab718b",
		]) {
			expect(evidence, commit).toContain(commit);
		}
	});

	it("preserves upstream attribution and separates its submission evidence from this fork", () => {
		const readme = read("README.md");

		expect(readme).toContain("[Signmos](https://github.com/auditmos/signmos)");
		expect(readme).toContain(
			"Original upstream submission evidence remains available in Git history",
		);
		expect(readme).toContain("it is not release evidence for this fork");
		expect(readme).toContain("Original Signmos copyright and third-party notices are preserved");
		expect(read(evidencePath)).toContain(
			"GPT-5.6 was used through Codex as a build-time engineering model",
		);
	});

	it("provides consistent Devpost copy and timestamped demo narration", () => {
		const evidence = read(evidencePath);

		expect(evidence).toContain("## Canonical Devpost description");
		expect(evidence).toContain("## Timestamped demo narration");
		expect(evidence).toContain("| `01:45–02:10` |");
		for (const phrase of [
			"GPT-5.6 was used through Codex as a build-time engineering model",
			"46 product/security decisions",
			"issues #43–#51",
			"not a Signmos runtime dependency",
			"matching-human review",
		]) {
			expect(evidence, phrase).toContain(phrase);
		}
		expect(evidence).not.toMatch(/(?:powered by|runs on|calls) GPT-5\.6/i);
	});

	it("enumerates every issue #59 acceptance criterion", () => {
		const evidence = read(evidencePath);
		const rows = evidence.match(/^\|\s*[1-7]\s*\|/gm) ?? [];

		expect(evidence).toContain("## Issue #59 verification");
		expect(rows).toHaveLength(7);
		expect(evidence).toContain("| 6 | Meaningful-use fallback");
		expect(evidence).toContain("Not applicable");
		expect(evidence).toContain("#54/#60");
	});
});
