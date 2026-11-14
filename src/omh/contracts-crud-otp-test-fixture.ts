import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import { hashAgenticCredential } from "@/db/agentic-access/request";
import { createHistorySessionFromVerifiedIdentity } from "@/db/history-access";
import { withDatabase } from "@/db/setup";
import { createAdminCsrfToken } from "./auth";
import { dispatchHostedRequest } from "./hosted-request";

const owner = "owner@example.com";
const otherOwner = "another@example.com";
const recipient = "ada@example.com";
const ownerToken = "signmos_crud_e2e_owner_token";
const otherToken = "signmos_crud_e2e_other_token";
let postgres: PGlite;
let files: Map<string, Uint8Array>;
let deliveries: Map<string, GatewayMail>;
let attempts: string[];
let loseInvitationReceipt: boolean;
let databaseCalls = 0;
let fileCalls = 0;
let browserSession: string;
let browserCsrf: string;
let afterUploadComplete: (() => Promise<void>) | undefined;
let failSourceSave = false;
let loseReservationReceipt = false;
let budgets: Array<{
	method: string;
	path: string;
	status: number;
	database: number;
	files: number;
	mail: number;
	total: number;
}>;

interface GatewayMail {
	to: string;
	subject: string;
	text: string;
	html: string;
}
function result(value: Results) {
	return {
		command: value.command ?? "SELECT",
		rowCount: value.rowCount ?? value.affectedRows ?? value.rows.length,
		rows: JSON.parse(JSON.stringify(value.rows)) as Record<string, unknown>[],
	};
}
function failure(error: unknown) {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
		return { type: "ohmyhost.database-error/v1", sqlstate: error.code };
	throw error;
}
const binding: CustomerDatabaseBinding = {
	query: async (raw) => {
		databaseCalls++;
		const query = raw as CustomerDatabaseQuery;
		try {
			return result(await postgres.query(query.text, [...query.values]));
		} catch (error) {
			return failure(error);
		}
	},
	transaction: async (raw) => {
		databaseCalls++;
		try {
			if (
				failSourceSave &&
				(raw as CustomerDatabaseQuery[]).some((query) =>
					query.text.includes("insert into source_documents"),
				)
			) {
				failSourceSave = false;
				return { type: "ohmyhost.database-error/v1", sqlstate: "40001" };
			}
			const transactionResult = await postgres.transaction(async (transaction) => {
				const results = [];
				for (const query of raw as CustomerDatabaseQuery[])
					results.push(result(await transaction.query(query.text, [...query.values])));
				return results;
			});
			if (
				loseReservationReceipt &&
				(raw as CustomerDatabaseQuery[]).some((query) =>
					query.text.includes("insert into envelopes"),
				)
			) {
				loseReservationReceipt = false;
				return { type: "ohmyhost.database-error/v1", sqlstate: "08006" };
			}
			return transactionResult;
		} catch (error) {
			return failure(error);
		}
	},
};
const env = {
	SIGN_ADMIN_EMAILS: `${owner},${otherOwner}`,
	SIGN_OTP_SECRET: "integration-only-secret-with-at-least-32-characters",
	APP_BASE_URL: "https://sign.example.com",
	CLOUDFLARE_ENV: "production",
	OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	OHMYHOST_ENVIRONMENT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
	OHMYHOST_STORAGE_GATEWAY_URL: "https://private-storage.example.com",
	OHMYHOST_STORAGE_KEY: "s".repeat(43),
	OHMYHOST_MAIL_GATEWAY_URL: "https://private-mail.example.com",
	OHMYHOST_MAIL_KEY: "m".repeat(43),
	SIGN_FROM_EMAIL: "contracts@mail.example.com",
	SIGN_REPLY_TO_EMAIL: owner,
} as unknown as Env;
const scoped = <T>(callback: () => Promise<T>) =>
	withDatabase({ OHMYHOST_DATABASE: binding }, callback);
async function request(path: string, init: RequestInit = {}) {
	const before = { database: databaseCalls, files: fileCalls, mail: attempts.length };
	const response = await dispatchHostedRequest(
		new Request(`https://sign.example.com${path}`, init),
		{ ...env, OHMYHOST_DATABASE: binding } as Env,
		async () => new Response("Unexpected page request", { status: 404 }),
	);
	const database = databaseCalls - before.database;
	const files = fileCalls - before.files;
	const mail = attempts.length - before.mail;
	budgets.push({
		method: init.method ?? "GET",
		path: path.replace(/\/(signing|final-documents|contracts)\/[^/]+/u, "/$1/:id"),
		status: response.status,
		database,
		files,
		mail,
		total: database + files + mail,
	});
	return response;
}
function browserAdmin(method: string, key: string, body?: unknown): RequestInit {
	const init = admin(method, key, body);
	const headers = new Headers(init.headers);
	headers.delete("authorization");
	headers.set("cookie", `signmos_history_session=${browserSession}`);
	headers.set("x-csrf-token", browserCsrf);
	headers.set("origin", env.APP_BASE_URL ?? "");
	return { ...init, headers };
}

function frame(value: unknown) {
	const json = new TextEncoder().encode(JSON.stringify(value));
	const bytes = new Uint8Array(json.length + 4);
	new DataView(bytes.buffer).setUint32(0, json.length);
	bytes.set(json, 4);
	return bytes;
}
async function storageGateway(input: Request) {
	fileCalls++;
	const url = new URL(input.url);
	if (url.origin === "https://signed-storage.example.com") {
		files.set(decodeURIComponent(url.pathname.slice(1)), new Uint8Array(await input.arrayBuffer()));
		return new Response(null, { status: 200 });
	}
	const body = (await input.json()) as {
		objectKey: string;
		contentLength: number;
		objectKeys: string[];
		objects: Array<{ objectKey: string }>;
	};
	const transferId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
	if (url.pathname === "/v1/uploads")
		return Response.json({
			state: "ready",
			transfer_id: transferId,
			capability: {
				operation: "PUT",
				objectKey: body.objectKey,
				url: `https://signed-storage.example.com/${encodeURIComponent(body.objectKey)}`,
				expiresAt: "2030-01-01T00:00:00.000Z",
				expectedContentLength: body.contentLength,
				requiredHeaders: {},
			},
		});
	if (url.pathname === "/v1/uploads/complete") {
		const hook = afterUploadComplete;
		afterUploadComplete = undefined;
		await hook?.();
		return Response.json({ state: "completed", transfer_id: transferId });
	}
	if (url.pathname === "/v1/deletions/batch") {
		for (const { objectKey } of body.objects) files.delete(objectKey);
		return Response.json({
			state: "completed",
			results: body.objects.map(({ objectKey }) => ({
				object_key: objectKey,
				state: "completed",
				deletion_id: transferId,
			})),
		});
	}
	if (url.pathname !== "/v1/downloads/batch")
		throw new Error("Unexpected fixture storage operation");
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const [index, objectKey] of body.objectKeys.entries()) {
					const bytes = files.get(objectKey);
					controller.enqueue(
						frame(
							bytes
								? {
										index,
										objectKey,
										state: "found",
										contentType: "application/pdf",
										contentLength: bytes.length,
										etag: "a".repeat(32),
									}
								: { index, objectKey, state: "not_found" },
						),
					);
					if (bytes) controller.enqueue(bytes);
				}
				controller.enqueue(frame({ state: "completed", count: body.objectKeys.length }));
				controller.close();
			},
		}),
		{ headers: { "content-type": "application/vnd.ohmyhost.storage-batch.v1" } },
	);
}
function admin(method: string, key: string, body?: unknown, token = ownerToken): RequestInit {
	return {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			"idempotency-key": key,
			...(body instanceof FormData ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
	};
}
beforeAll(async () => {
	postgres = new PGlite();
	const migrations = new URL("../../database/omh-migrations/", import.meta.url);
	for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(name, migrations), "utf8"));
}, 20_000);
afterAll(async () => postgres.close());
beforeEach(async () => {
	await postgres.exec("TRUNCATE envelopes,agentic_api_tokens,history_access_links CASCADE");
	files = new Map();
	deliveries = new Map();
	attempts = [];
	loseInvitationReceipt = false;
	afterUploadComplete = undefined;
	failSourceSave = false;
	loseReservationReceipt = false;
	budgets = [];
	const session = await scoped(() =>
		createHistorySessionFromVerifiedIdentity({
			email: owner,
			verifiedUntil: new Date(Date.now() + 60 * 60 * 1000),
		}),
	);
	browserSession = session.rawSession;
	browserCsrf = await createAdminCsrfToken(browserSession);
	for (const [email, token] of [
		[owner, ownerToken],
		[otherOwner, otherToken],
	] as const)
		await postgres.query(
			"INSERT INTO agentic_api_tokens(email,name,token_hash,token_hint,status,active_slot) VALUES($1,'Test',$2,'test','active',1)",
			[email, await hashAgenticCredential(token)],
		);
	vi.stubGlobal("fetch", async (input: Request) => {
		if (new URL(input.url).origin !== env.OHMYHOST_MAIL_GATEWAY_URL) return storageGateway(input);
		expect(new URL(input.url).origin).toBe(env.OHMYHOST_MAIL_GATEWAY_URL);
		const body = (await input.json()) as GatewayMail;
		const key = input.headers.get("idempotency-key");
		if (!key) throw new Error("Missing gateway idempotency key");
		expect(body).not.toHaveProperty("attachments");
		attempts.push(key);
		const previous = deliveries.get(key);
		if (previous) expect(body).toEqual(previous);
		deliveries.set(key, body);
		if (loseInvitationReceipt && key.startsWith("sign.invitation.")) {
			loseInvitationReceipt = false;
			throw new Error("Simulated lost gateway receipt after acceptance");
		}
		return Response.json(
			{
				state: "accepted",
				request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
				message_id: `fixture-${deliveries.size}`,
			},
			{ status: 202 },
		);
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	expect(budgets.filter(({ total }) => total > 10)).toEqual([]);
});

export {
	owner,
	recipient,
	otherToken,
	postgres,
	deliveries,
	attempts,
	env,
	scoped,
	request,
	admin,
	browserAdmin,
};
export function loseNextInvitationReceipt() {
	loseInvitationReceipt = true;
}
export function storedFileCount() {
	return files.size;
}
export function afterNextUploadComplete(callback: () => Promise<void>) {
	afterUploadComplete = callback;
}
export function requestBudgets() {
	return budgets;
}
export function failNextSourceSave() {
	failSourceSave = true;
}
export function loseNextReservationReceipt() {
	loseReservationReceipt = true;
}
