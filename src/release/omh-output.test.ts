import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkOmhWorkerOutput, PLATFORM_WORKER_CONFIG_KEYS } from "../../scripts/check-omh-output";

// The ohmyho.st build refuses a Worker output with source maps, a generated config with other
// keys than its allow-list, and Worker text with a non-root "<prefix>/assets/" reference. These
// tests build small dist/server trees; the real output is checked by `pnpm run omh:output`.
let serverRoot: string;

beforeEach(async () => {
	serverRoot = await mkdtemp(join(tmpdir(), "omh-output-"));
});
afterEach(async () => {
	await rm(serverRoot, { recursive: true, force: true });
});

async function writeServerFiles(files: Record<string, string>): Promise<void> {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(serverRoot, path)), { recursive: true });
		await writeFile(join(serverRoot, path), text);
	}
}

function platformConfig(change: (config: Record<string, unknown>) => void = () => undefined) {
	const config: Record<string, unknown> = Object.fromEntries(
		PLATFORM_WORKER_CONFIG_KEYS.map((key) => [key, null]),
	);
	change(config);
	return JSON.stringify(config);
}

async function validTree(extra: Record<string, string> = {}): Promise<void> {
	await writeServerFiles({
		"wrangler.json": platformConfig(),
		"index.js": 'export default { fetch: () => new Response("ok") };\n',
		...extra,
	});
}

describe("ohmyho.st Worker output guard", () => {
	it("pins the key list to the 47 keys of the platform allow-list", () => {
		expect(PLATFORM_WORKER_CONFIG_KEYS).toHaveLength(47);
		expect(new Set(PLATFORM_WORKER_CONFIG_KEYS).size).toBe(47);
		expect(PLATFORM_WORKER_CONFIG_KEYS).toEqual(
			expect.arrayContaining(["main", "assets", "no_bundle"]),
		);
		for (const refused of ["k2", "upload_source_maps", "secrets"])
			expect(PLATFORM_WORKER_CONFIG_KEYS).not.toContain(refused);
	});

	it("accepts an output the platform packaging accepts", async () => {
		await validTree({
			"assets/chunk.js": "export const chunk = 1;\n",
			"assets/worker-entry.js": 'const logo = "/assets/logo.png";\nexport { logo };\n',
		});
		await expect(checkOmhWorkerOutput(serverRoot)).resolves.toEqual([]);
	});

	it.each([
		"index.js.map",
		"assets/chunk.js.map",
		"python/module.py",
		"python/module.pyc",
	])("reports %s, which the packaging refuses", async (file) => {
		await validTree({ [file]: "refused" });
		await expect(checkOmhWorkerOutput(serverRoot)).resolves.toEqual([
			expect.stringContaining(file),
		]);
	});

	it.each([
		"k2",
		"upload_source_maps",
	])("reports the generated config key %s that the platform does not accept", async (key) => {
		await writeServerFiles({
			"wrangler.json": platformConfig((config) => {
				config[key] = [];
			}),
			"index.js": "export default {};\n",
		});
		await expect(checkOmhWorkerOutput(serverRoot)).resolves.toEqual([
			expect.stringContaining(`"${key}"`),
		]);
	});

	it("reports a key the platform requires but the generated config lacks", async () => {
		await writeServerFiles({
			"wrangler.json": platformConfig((config) => {
				delete config.no_bundle;
			}),
			"index.js": "export default {};\n",
		});
		await expect(checkOmhWorkerOutput(serverRoot)).resolves.toEqual([
			expect.stringContaining('"no_bundle"'),
		]);
	});

	it("reports a missing or unreadable generated config instead of throwing", async () => {
		await writeServerFiles({ "index.js": "export default {};\n" });
		await expect(checkOmhWorkerOutput(serverRoot)).resolves.toEqual([
			expect.stringContaining("wrangler.json"),
		]);
		await writeServerFiles({ "wrangler.json": "[1, 2" });
		await expect(checkOmhWorkerOutput(serverRoot)).resolves.toEqual([
			expect.stringContaining("wrangler.json"),
		]);
		await writeServerFiles({ "wrangler.json": "[]" });
		await expect(checkOmhWorkerOutput(serverRoot)).resolves.toEqual([
			expect.stringContaining("wrangler.json"),
		]);
	});

	it.each([
		["a URL", 'const docs = "https://pdf-lib.js.org/assets/x";'],
		["a nested root path", 'const logo = "/docs/assets/logo.png";'],
		["a relative path in a string", 'const logo = "./assets/logo.png";'],
		[
			"a JSDoc example",
			"/**\n * @example\n * fetch('https://pdf-lib.js.org/assets/with_cat_emoji.pdf')\n */\nexport {};",
		],
	])("reports %s with an assets prefix in Worker text", async (_name, text) => {
		await validTree({ "assets/pdf-lib.js": `${text}\n` });
		await expect(checkOmhWorkerOutput(serverRoot)).resolves.toEqual([
			expect.stringContaining("assets/pdf-lib.js"),
		]);
	});

	it("does not report relative module specifiers into an assets directory", async () => {
		await validTree({
			"index.js": [
				"import './assets/chunk.js';",
				'import { chunk } from "./assets/chunk.js";',
				'export * from "../assets/other.js";',
				'export const lazy = () => import("./assets/lazy.js");',
				"",
			].join("\n"),
			"assets/chunk.js": "export const chunk = 1;\n",
		});
		await expect(checkOmhWorkerOutput(serverRoot)).resolves.toEqual([]);
	});

	it("reports every problem at once", async () => {
		await writeServerFiles({
			"wrangler.json": platformConfig((config) => {
				config.k2 = [];
			}),
			"index.js": "export default {};\n",
			"index.js.map": "{}",
			"assets/pdf-lib.js": 'const docs = "https://pdf-lib.js.org/assets/x";\n',
		});
		const problems = await checkOmhWorkerOutput(serverRoot);
		expect(problems).toHaveLength(3);
		expect(problems).toEqual(
			expect.arrayContaining([
				expect.stringContaining("index.js.map"),
				expect.stringContaining('"k2"'),
				expect.stringContaining("assets/pdf-lib.js"),
			]),
		);
	});
});
