import { spawn } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The keys the ohmyho.st build runner accepts in the generated dist/server/wrangler.json
 * (TANSTACK_GENERATED_CONFIG_KEYS in apps/build-runner/sandbox/build-runtime.mjs of the platform;
 * 47 keys when this list was copied on 2026-10-22). Refresh it when the platform changes it. It is
 * a snapshot: the platform's own validator and packager stay the authority.
 */
export const PLATFORM_WORKER_CONFIG_KEYS: readonly string[] = [
	"agent_memory",
	"ai_search",
	"ai_search_namespaces",
	"analytics_engine_datasets",
	"artifacts",
	"assets",
	"cloudchamber",
	"compatibility_date",
	"compatibility_flags",
	"configPath",
	"connect",
	"d1_databases",
	"definedEnvironments",
	"dev",
	"dispatch_namespaces",
	"durable_objects",
	"exports",
	"flagship",
	"hyperdrive",
	"jsx_factory",
	"jsx_fragment",
	"kv_namespaces",
	"logfwdr",
	"main",
	"migrations",
	"mtls_certificates",
	"name",
	"no_bundle",
	"pipelines",
	"python_modules",
	"queues",
	"r2_buckets",
	"ratelimits",
	"rules",
	"secrets_store_secrets",
	"send_email",
	"services",
	"topLevelName",
	"triggers",
	"unsafe_hello_world",
	"userConfigPath",
	"vars",
	"vectorize",
	"vpc_networks",
	"vpc_services",
	"worker_loaders",
	"workflows",
];

/** Where the build runner writes its own Worker config; the build is pointed at it by env var. */
const PLATFORM_CONFIG_NAME = ".ohmyhost-tanstack-wrangler.jsonc";
/** PLATFORM_COMPATIBILITY_DATE of the platform's TanStack adapter. */
const PLATFORM_COMPATIBILITY_DATE = "2026-08-21";
const HEARTBEAT_MILLISECONDS = 5_000;

/**
 * The build runner refuses Worker text that mentions an assets path below a prefix (a URL, a
 * nested path or a relative path in a string); a root "/assets/" is the framework's own.
 */
const nonRootAssetReference =
	/(?:https?:)?\/\/[^\s"'<>]+\/assets\/|\/(?:[A-Za-z0-9._~-]+\/)+assets\/|(?:^|[\s"'(=:`])(?:\.\.?\/|[A-Za-z0-9._~-]+\/)*assets\//u;
/**
 * The build runner masks relative module specifiers (it uses a module lexer); this approximation
 * blanks `from "./assets/x.js"` and `import("../assets/x.js")` before the scan.
 */
const relativeAssetImport =
	/(\bfrom\s*|\bimport\s*\(?\s*)(["'])\.{1,2}\/(?:[A-Za-z0-9._~-]+\/)*assets\/[^"']*\2/gu;

async function filesUnder(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) =>
			entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
		),
	);
	return nested.flat();
}

async function configKeyProblems(serverRoot: string): Promise<string[]> {
	let config: unknown;
	try {
		config = JSON.parse(await readFile(join(serverRoot, "wrangler.json"), "utf8"));
	} catch {
		return ["wrangler.json is missing or is not valid JSON"];
	}
	if (typeof config !== "object" || config === null || Array.isArray(config))
		return ["wrangler.json is not a JSON object"];
	const keys = Object.keys(config);
	return [
		...keys
			.filter((key) => !PLATFORM_WORKER_CONFIG_KEYS.includes(key))
			.map((key) => `wrangler.json has the key "${key}", which the platform does not accept`),
		...PLATFORM_WORKER_CONFIG_KEYS.filter((key) => !keys.includes(key)).map(
			(key) => `wrangler.json lacks the key "${key}", which the platform requires`,
		),
	];
}

async function assetReferenceProblems(serverRoot: string, files: string[]): Promise<string[]> {
	const problems: string[] = [];
	for (const file of files.filter((name) => name.endsWith(".js"))) {
		const text = (await readFile(file, "utf8")).replace(relativeAssetImport, (match) =>
			" ".repeat(match.length),
		);
		const hit = nonRootAssetReference.exec(text);
		if (!hit) continue;
		const excerpt = JSON.stringify(text.slice(Math.max(0, hit.index - 30), hit.index + 60));
		problems.push(
			`${relative(serverRoot, file)}: contains a non-root "<prefix>/assets/" reference near ${excerpt}; the platform masks more than this check, so confirm a hit with its own validator`,
		);
	}
	return problems;
}

/**
 * Problems that would make the ohmyho.st packaging refuse the Worker output in `serverRoot`
 * (dist/server); empty when none is found. A pass is not the platform's pass: its validator
 * checks more, and this check only approximates the masking of its asset scan.
 */
export async function checkOmhWorkerOutput(serverRoot: string): Promise<string[]> {
	const files = (await filesUnder(serverRoot)).sort();
	const refused = files
		.filter((name) => /\.(?:map|py|pyc)$/u.test(name))
		.map(
			(file) => `${relative(serverRoot, file)}: the packaging refuses source maps and Python files`,
		);
	return [
		...refused,
		...(await configKeyProblems(serverRoot)),
		...(await assetReferenceProblems(serverRoot, files)),
	];
}

function heartbeat(message: string): void {
	process.stdout.write(`[omh:output] ${message}\n`);
}

/** `pnpm run build`, which is what the build runner runs, with its Worker config selected. */
async function runPlatformBuild(root: string, configPath: string): Promise<void> {
	// The build runner's environment has no CLOUDFLARE_ENV: a Wrangler environment would select
	// blocks that its minimal Worker config does not have. (worker-configuration.d.ts types the
	// Sign variables as required members of ProcessEnv, which `delete` refuses.)
	const inherited = { ...process.env };
	Reflect.deleteProperty(inherited, "CLOUDFLARE_ENV");
	const startedAt = Date.now();
	const timer = setInterval(
		() => heartbeat(`still building, ${Math.round((Date.now() - startedAt) / 1000)} s`),
		HEARTBEAT_MILLISECONDS,
	);
	try {
		await new Promise<void>((resolveBuild, rejectBuild) => {
			const child = spawn("pnpm", ["run", "build"], {
				cwd: root,
				stdio: "inherit",
				env: {
					...inherited,
					CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: configPath,
					CI: "1",
					WRANGLER_SEND_METRICS: "false",
				},
			});
			child.on("error", rejectBuild);
			child.on("exit", (code, signal) =>
				code === 0
					? resolveBuild()
					: rejectBuild(new Error(`pnpm run build ended with ${code ?? signal}`)),
			);
		});
	} finally {
		clearInterval(timer);
	}
}

async function main(): Promise<void> {
	const root = resolve(import.meta.dirname, "..");
	const configPath = join(root, PLATFORM_CONFIG_NAME);
	await writeFile(
		configPath,
		JSON.stringify({
			name: "ohmyhost-platform-tanstack-build",
			main: "@tanstack/react-start/server-entry",
			compatibility_date: PLATFORM_COMPATIBILITY_DATE,
			compatibility_flags: ["nodejs_compat"],
		}),
	);
	heartbeat("building into dist/ with the ohmyho.st build runner's Worker configuration");
	try {
		await runPlatformBuild(root, configPath);
	} finally {
		await rm(configPath, { force: true });
	}
	heartbeat("checking dist/server");
	const problems = await checkOmhWorkerOutput(join(root, "dist", "server"));
	for (const problem of problems) process.stderr.write(`[omh:output] ${problem}\n`);
	if (problems.length > 0) {
		process.exitCode = 1;
		return;
	}
	heartbeat("no problem found; the ohmyho.st build runner remains the authority");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
