import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_readConfig } from "wrangler";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function executable(path: string, body: string) {
	writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
	chmodSync(path, 0o755);
}

function runDeploymentScript(
	mode: "--dry-run" | "--deploy",
	options: { gitStatus?: string; productionVars?: string } = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "signmos-production-deploy-"));
	const log = join(directory, "commands.log");
	const productionVarsFile = join(directory, "production.vars");
	if (options.productionVars) writeFileSync(productionVarsFile, options.productionVars);
	executable(
		join(directory, "git"),
		'if [[ "$1" == "rev-parse" ]]; then printf "07c2b1c000000000000000000000000000000000\\n"; fi\n' +
			`if [[ "$1" == "status" ]]; then printf "%s" "\${DEPLOY_TEST_GIT_STATUS:-}"; fi\n`,
	);
	executable(
		join(directory, "pnpm"),
		'if [[ "$1" == "build" ]] && [[ ! -f .dev.vars.production ]]; then printf "missing isolated production build vars\\n" >&2; exit 42; fi\n' +
			`printf "pnpm|%s|%s\\n" "\${CLOUDFLARE_ENV:-unset}" "$*" >> "$DEPLOY_TEST_LOG"\n`,
	);
	executable(join(directory, "curl"), 'printf "curl|%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n');

	try {
		const result = spawnSync("bash", ["scripts/deploy-production.sh", mode], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: {
				...process.env,
				DEPLOY_TEST_LOG: log,
				DEPLOY_TEST_GIT_STATUS: options.gitStatus ?? "",
				PATH: `${directory}:${process.env.PATH ?? ""}`,
				SIGNMOS_PRODUCTION_VARS_FILE: productionVarsFile,
			},
		});
		return {
			commands: existsSync(log) ? readFileSync(log, "utf8") : "",
			result,
			temporaryBuildVarsPresent: existsSync(resolve(repositoryRoot, ".dev.vars.production")),
		};
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

/**
 * Issue #61 deployment assumptions:
 * - The user-selected public origin is exactly https://signmos.com. The `www`
 *   hostname is not added silently; it can receive an explicit redirect later.
 * - The production Worker is the origin, so it uses a Cloudflare Custom Domain
 *   rather than a route in front of another server.
 * - Production has no workers.dev or version-preview ingress. Judges and email
 *   links use one stable origin.
 * - A real deploy must come from a clean Git commit, build with
 *   CLOUDFLARE_ENV=production, validate required remote secret names, and prove
 *   the generated configuration with a Wrangler dry run before publishing.
 * - The live code and complete validated dotenv secret set are uploaded in one
 *   Wrangler deploy operation. No secret command may create an intermediate
 *   production version before the candidate code is published.
 * - Tests do not deploy or inspect secret values; command boundaries are faked.
 */
describe("production deployment", () => {
	it("publishes only the production Worker at the signmos.com custom domain", () => {
		const config = unstable_readConfig(
			{ config: "wrangler.jsonc", env: "production" },
			{ hideWarnings: true, preserveOriginalMain: true },
		);

		expect(config.name).toBe("signmos-production");
		expect(config.workers_dev).toBe(false);
		expect(config.preview_urls).toBe(false);
		expect(config.routes).toEqual([
			{
				pattern: "signmos.com",
				custom_domain: true,
			},
		]);
		expect(config.r2_buckets).toEqual([
			{
				binding: "DOCUMENTS_BUCKET",
				bucket_name: "signmos-documents-production",
			},
		]);
	});

	it("builds the production environment and proves the generated deployment without publishing", () => {
		const { commands, result, temporaryBuildVarsPresent } = runDeploymentScript("--dry-run");

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Production deploy dry run passed");
		expect(temporaryBuildVarsPresent).toBe(false);
		expect(commands).toBe(
			[
				"pnpm|production|build",
				"pnpm|unset|exec wrangler deploy --config dist/server/wrangler.json --dry-run",
				"",
			].join("\n"),
		);
	});

	it("deploys validated production secrets with the exact code version and checks public endpoints", () => {
		const { commands, result } = runDeploymentScript("--deploy", {
			productionVars: [
				'CLOUDFLARE_ENV="production"',
				'DATABASE_HOST="db.example.test"',
				'DATABASE_USERNAME="test-user"',
				'DATABASE_PASSWORD="test-password"',
				'APP_BASE_URL="https://signmos.com"',
				'RESEND_API_KEY="test-resend"',
				'RESEND_FROM_EMAIL="Signmos <signmos@example.test>"',
				'RESEND_REPLY_TO_EMAIL="reply@example.test"',
				'TURNSTILE_SITE_KEY="test-site"',
				'TURNSTILE_SECRET_KEY="test-secret"',
				"",
			].join("\n"),
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(
			"Deployed candidate 07c2b1c000000000000000000000000000000000 to https://signmos.com",
		);
		expect(commands).toContain("pnpm|unset|exec wrangler whoami\n");
		expect(commands).toContain(
			"pnpm|unset|exec wrangler r2 bucket info signmos-documents-production\n",
		);
		expect(commands).toContain("pnpm|production|build\n");
		expect(commands).toContain(
			"pnpm|unset|exec wrangler deploy --config dist/server/wrangler.json --dry-run\n",
		);
		expect(commands).not.toContain("wrangler secret bulk");
		expect(commands).not.toContain(" --yes");
		expect(commands).toMatch(
			/pnpm\|unset\|exec wrangler deploy --config dist\/server\/wrangler\.json --secrets-file \/.*\/production\.vars --message git:07c2b1c000000000000000000000000000000000\n/,
		);
		for (const url of [
			"https://signmos.com/",
			"https://signmos.com/agent.md",
			"https://signmos.com/openapi.json",
		]) {
			expect(commands).toContain(
				`curl|--fail --silent --show-error --location --retry 3 --retry-all-errors --max-time 30 --output /dev/null ${url}\n`,
			);
		}
	});

	it("refuses to publish a working tree that cannot be tied to one exact commit", () => {
		const { commands, result } = runDeploymentScript("--deploy", {
			gitStatus: " M README.md\n",
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Production deploy requires a clean working tree");
		expect(commands).toBe("");
	});

	it("documents production ownership, verification, and recovery through the judging window", () => {
		const runbook = readFileSync(resolve(repositoryRoot, "docs/PRODUCTION_DEPLOYMENT.md"), "utf8");

		for (const phrase of [
			"## Ownership and judging window",
			"Individual submitter",
			"2026-08-05 17:00 PDT",
			"2026-08-06 02:00 CEST",
			'APP_BASE_URL="https://signmos.com"',
			"./scripts/deploy-production.sh --dry-run",
			"./scripts/deploy-production.sh --deploy",
			"`--secrets-file`",
			"one Worker version",
			"production debug fallback links remain disabled",
			"https://signmos.com/agent.md",
			"https://signmos.com/openapi.json",
			"pnpm agentic:smoke",
			"pnpm exec wrangler rollback --config wrangler.jsonc --env production",
		]) {
			expect(runbook, phrase).toContain(phrase);
		}
	});

	it("documents this fork's OMH deployment configuration and readiness check", () => {
		const readme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
		const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};

		expect(readme).toContain("[ohmyhost.yaml](ohmyhost.yaml)");
		expect(readme).toContain("pnpm omh:check");
		expect(readme).toContain("database/omh-migrations");
		expect(manifest.scripts.deploy).toBe("ohmyhost deploy");
		expect(manifest.scripts["omh:check"]).toContain("ohmyhost init --dry-run");
	});
});
