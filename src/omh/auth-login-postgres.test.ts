import { readdir, readFile } from "node:fs/promises";
import { PGlite, type Results } from "@electric-sql/pglite";
import type {
	CustomerDatabaseBinding,
	CustomerDatabaseQuery,
} from "@ohmyhost/customer-runtime/database";
import {
	ADMIN_LOGIN_MAILS_PER_DAY,
	takeAdminLoginMailBudget,
} from "@/db/history-access/request-abuse";
import { withDatabase } from "@/db/setup";
import { requestAdminLogin } from "./auth-login";

const owner = "owner@example.com";
let postgres: PGlite;
let privateCalls: number;
let mails: Array<{ to: string }>;
let mailAnswer: (() => Response) | undefined;

function result(value: Results) {
	return {
		command: value.command ?? "SELECT",
		rowCount: value.rowCount ?? value.affectedRows ?? value.rows.length,
		rows: JSON.parse(JSON.stringify(value.rows)) as Record<string, unknown>[],
	};
}
const binding: CustomerDatabaseBinding = {
	query: async (raw) => {
		privateCalls += 1;
		const query = raw as CustomerDatabaseQuery;
		return result(await postgres.query(query.text, [...query.values]));
	},
	transaction: async (raw) => {
		privateCalls += 1;
		const queries = raw as CustomerDatabaseQuery[];
		return postgres.transaction(async (transaction) => {
			const results = [];
			for (const query of queries)
				results.push(result(await transaction.query(query.text, [...query.values])));
			return results;
		});
	},
};
const env = {
	SIGN_ADMIN_EMAILS: owner,
	OHMYHOST_PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	OHMYHOST_MAIL_GATEWAY_URL: "https://private-mail.example.com",
	OHMYHOST_MAIL_KEY: "m".repeat(43),
	SIGN_FROM_EMAIL: "contracts@mail.example.com",
	OHMYHOST_MAIL_GATEWAY: {
		fetch: async (request: Request) => {
			privateCalls += 1;
			mails.push({ to: ((await request.json()) as { to: string }).to });
			return (
				mailAnswer?.() ??
				Response.json(
					{ state: "accepted", request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", message_id: "login-1" },
					{ status: 202 },
				)
			);
		},
	},
} as unknown as Env;

function login(email = owner, requestIp = "203.0.113.1") {
	return withDatabase({ OHMYHOST_DATABASE: binding }, () =>
		requestAdminLogin({
			email,
			env,
			requestIp,
			emailDelivery: { env, baseUrl: "https://sign.example.com" },
		}),
	);
}
async function budgetRows() {
	return (
		await postgres.query<{ attempts: number }>(
			"SELECT attempts FROM rate_limit_records WHERE operation='admin-login-mail'",
		)
	).rows;
}

beforeAll(async () => {
	postgres = new PGlite();
	const migrations = new URL("../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(file, migrations), "utf8"));
}, 20_000);
afterAll(async () => {
	await postgres.close();
});
beforeEach(async () => {
	await postgres.exec("TRUNCATE rate_limit_records, history_access_links CASCADE");
	privateCalls = 0;
	mails = [];
	mailAnswer = undefined;
});
afterEach(() => vi.useRealTimers());

describe("administrator login mail budget", () => {
	it("sends at most four login mails to the administrator in 24 hours, answering every request alike", async () => {
		for (let attempt = 1; attempt <= 5; attempt += 1)
			await expect(login(owner, `203.0.113.${attempt}`)).resolves.toBeUndefined();
		expect(mails).toHaveLength(4);
		expect(await budgetRows()).toEqual([{ attempts: 5 }]);
		// The fifth request created no link: only the four mailed links exist.
		expect(
			(await postgres.query("SELECT count(*)::integer AS count FROM history_access_links")).rows,
		).toEqual([{ count: 4 }]);
	});

	it("keeps the mail budget exact when requests arrive at the same time", async () => {
		const grants = await withDatabase({ OHMYHOST_DATABASE: binding }, () =>
			Promise.all(
				Array.from({ length: 12 }, () =>
					takeAdminLoginMailBudget({ email: ` ${owner.toUpperCase()} `, now: new Date() }),
				),
			),
		);
		expect(grants.filter(Boolean)).toHaveLength(ADMIN_LOGIN_MAILS_PER_DAY);
		expect(await budgetRows()).toEqual([{ attempts: 12 }]);
	});

	it("grants a new budget when the 24 hour window has passed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-22T08:00:00Z"));
		for (let attempt = 1; attempt <= 5; attempt += 1) await login(owner, `203.0.113.${attempt}`);
		expect(mails).toHaveLength(4);
		vi.setSystemTime(new Date("2026-10-23T08:00:01Z"));
		await login(owner, "203.0.113.9");
		expect(mails).toHaveLength(5);
		expect(await budgetRows()).toEqual([{ attempts: 1 }]);
	});

	it("spends no budget and sends nothing for an address that is not an administrator", async () => {
		await expect(login("stranger@example.com")).resolves.toBeUndefined();
		expect(mails).toHaveLength(0);
		expect(await budgetRows()).toEqual([]);
	});

	it("uses eight private calls for a login, leaving two spare", async () => {
		await login();
		expect(mails).toHaveLength(1);
		expect(privateCalls).toBe(8);
	});

	it("counts a refused mail against the budget as well", async () => {
		mailAnswer = () => Response.json({ code: "mail_send_daily_limit" }, { status: 429 });
		await expect(login(owner, "203.0.113.1")).rejects.toMatchObject({
			code: "mail_send_limit_exceeded",
		});
		expect(await budgetRows()).toEqual([{ attempts: 1 }]);
	});
});
