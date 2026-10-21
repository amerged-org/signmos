import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import agentV1Endpoint from "@/hono/api/agent-v1";
import { publicAgentContractHono } from "@/hono/public-agent-contract";

type OpenApiOperation = {
	operationId?: string;
	security?: unknown;
	parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
	requestBody?: unknown;
	responses?: Record<
		string,
		{
			headers?: Record<string, unknown>;
			content?: Record<string, { schema?: { type?: string; format?: string } }>;
		}
	>;
};

type OpenApiDocument = {
	paths: Record<string, Record<string, OpenApiOperation>>;
};

const releaseEvidenceRoot = "plans/evidence/agentic-mode-release";

describe("agent API contract release", () => {
	it("agent API contract keeps runtime routes and published operations in exact parity", async () => {
		const response = await publicAgentContractHono.request("/openapi.json");
		expect(response.status).toBe(200);
		const document = (await response.json()) as OpenApiDocument;
		const runtime = agentV1Endpoint.routes
			.filter((route) => route.method !== "ALL")
			.map((route) => `${route.method.toLowerCase()} ${toPublicPath(route.path)}`)
			.sort();
		const published = Object.entries(document.paths)
			.flatMap(([path, methods]) =>
				Object.keys(methods).map((method) => `${method.toLowerCase()} ${path}`),
			)
			.sort();
		expect(published).toEqual(runtime);

		for (const [path, methods] of Object.entries(document.paths)) {
			for (const [method, operation] of Object.entries(methods)) {
				expect(operation.operationId, `${method} ${path} operationId`).toBeTruthy();
				expect(operation.security, `${method} ${path} Bearer security`).toEqual([
					{ bearerAuth: [] },
				]);
				expect(successResponse(operation), `${method} ${path} success response`).toBeTruthy();
				expect(operation.responses?.["401"], `${method} ${path} auth error`).toBeTruthy();
				const limited = operation.responses?.["429"];
				expect(limited, `${method} ${path} rate-limit error`).toBeTruthy();
				expect(Object.keys(limited?.headers ?? {}).sort()).toEqual([
					"RateLimit-Limit",
					"RateLimit-Remaining",
					"RateLimit-Reset",
					"Retry-After",
				]);

				const mutation = ["post", "put", "patch", "delete"].includes(method);
				const idempotency = operation.parameters?.find(
					(parameter) => parameter.name === "Idempotency-Key",
				);
				if (mutation) {
					expect(idempotency, `${method} ${path} idempotency`).toEqual(
						expect.objectContaining({ in: "header", required: true }),
					);
					expect(operation.requestBody, `${method} ${path} request body`).toBeTruthy();
				} else {
					expect(idempotency, `${method} ${path} read idempotency`).toBeUndefined();
				}
			}
		}

		expect(document.paths["/api/v1/documents/{documentId}/source-pdf"]?.put?.requestBody).toEqual(
			expect.objectContaining({
				content: {
					"application/pdf": {
						schema: {
							type: "string",
							format: "binary",
							maxLength: 2_097_152,
							description: "At most 2097152 bytes and 10 PDF pages",
						},
					},
				},
			}),
		);
		for (const path of [
			"/api/v1/documents/{documentId}/source-pdf/content",
			"/api/v1/documents/{documentId}/pdf",
		]) {
			expect(
				document.paths[path]?.get?.responses?.["200"]?.content?.["application/pdf"]?.schema,
			).toEqual({ type: "string", format: "binary" });
		}
	});

	it("agent API contract guidance covers the complete safe operating loop", async () => {
		const response = await publicAgentContractHono.request("/agent.md");
		expect(response.status).toBe(200);
		const guidance = await response.text();
		for (const phrase of [
			"SIGNMOS_TOKEN",
			"Confirm identity",
			"Discover documents",
			"Create a self-sign draft",
			"Upload one source PDF",
			"Manage draft recipients",
			"Place signature and date fields",
			"Send the partner invitation",
			"Resend an eligible invitation",
			"Complete partner signing",
			"Request creator changes",
			"Decline partner signing",
			"Upload a revision",
			"Cancel or expire",
			"Delete and revoke",
			"Download a completed PDF",
			"allowedActions",
			"Idempotency-Key",
			"POST, PUT, PATCH, or DELETE",
			"RateLimit-Limit",
			"Retry-After",
			"exponential backoff",
			"stay within the user goal",
			"automatically selects a newly generated token",
		]) {
			expect(guidance, phrase).toContain(phrase);
		}
		expect(guidance).not.toContain("This API phase is read-only");
	});

	it("retains complete parity, measurement, redaction, browser, and 44-story evidence", async () => {
		for (const file of [
			"capability-matrix.md",
			"calibration.md",
			"credential-redaction.md",
			"browser-smokes.md",
			"keyboard-walkthrough.md",
			"release-evidence.md",
		]) {
			expect(existsSync(resolve(releaseEvidenceRoot, file)), file).toBe(true);
		}
		const capability = read("capability-matrix.md");
		const openapi = (await (
			await publicAgentContractHono.request("/openapi.json")
		).json()) as OpenApiDocument;
		verifyCapabilityRows(capability, openapi);
		if (!existsSync(resolve(releaseEvidenceRoot, "release-evidence.md"))) return;

		const release = read("release-evidence.md");
		const storyRows = release.match(/^\|\s*(?:[1-9]|[1-3]\d|4[0-4])\s*\|/gm) ?? [];
		expect(storyRows).toHaveLength(44);
		for (const bound of [
			"30-minute",
			"15-minute",
			"five-token",
			"256-bit",
			"10 MB",
			"1–10 recipient",
			"seven-day",
			"90-day",
			"idempotency",
			"revocation",
			"redaction",
			"measured rate",
		]) {
			expect(release, bound).toContain(bound);
		}
		expect(release).toContain("44 of 44 verified");
	});

	it("publishes runnable measured calibration and Bearer lifecycle smoke commands", () => {
		const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		expect(packageJson.scripts?.["agentic:calibrate"]).toBeTruthy();
		expect(packageJson.scripts?.["agentic:smoke"]).toBeTruthy();
	});
});

function read(file: string): string {
	return readFileSync(resolve(releaseEvidenceRoot, file), "utf8");
}

function verifyCapabilityRows(capability: string, openapi: OpenApiDocument): void {
	for (const [path, methods] of Object.entries(openapi.paths)) {
		for (const [method, operation] of Object.entries(methods)) {
			expect(capability, `${method} ${path}`).toContain(`\`${operation.operationId}\``);
			if (!["post", "put", "patch", "delete"].includes(method)) continue;
			const row = capability
				.split("\n")
				.find((line) => line.includes(`\`${operation.operationId}\``));
			expect(row, `${method} ${path} replay/conflict evidence`).toContain(
				"Required; exact replay/conflict",
			);
		}
	}
}

function toPublicPath(path: string): string {
	return `/api/v1${path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}")}`;
}

function successResponse(operation: OpenApiOperation) {
	return Object.entries(operation.responses ?? {}).find(([status]) => status.startsWith("2"))?.[1];
}
