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
import { MailDeliveryUncertainError, setOmhMailTransport } from "./mail";

const owner = "owner@example.com";
let postgres: PGlite;
let privateCalls: number;
/** Every request that reached the gateway double, and whether it answered that it took the mail. */
let mails: Array<{ to: string; accepted: boolean }>;
let mailAnswer: (() => Response) | undefined;
/** Makes a private database call fail like a call limit, before it reaches the database. */
let failQuery: ((query: CustomerDatabaseQuery) => boolean) | undefined;

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
		if (failQuery?.(query)) throw new Error("Too many subrequests");
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
} as unknown as Env;
async function mailGateway(request: Request): Promise<Response> {
	privateCalls += 1;
	const to = ((await request.json()) as { to: string }).to;
	const answer =
		mailAnswer?.() ??
		Response.json(
			{ state: "accepted", request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", message_id: "login-1" },
			{ status: 202 },
		);
	mails.push({ to, accepted: answer.status === 202 });
	return answer;
}

function login(email = owner, requestIp = "203.0.113.1", mailEnv: Env = env) {
	return withDatabase({ OHMYHOST_DATABASE: binding }, () =>
		requestAdminLogin({
			email,
			env: mailEnv,
			requestIp,
			emailDelivery: { env: mailEnv, baseUrl: "https://sign.example.com" },
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
	setOmhMailTransport(mailGateway);
	postgres = new PGlite();
	const migrations = new URL("../../database/omh-migrations/", import.meta.url);
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
		await postgres.exec(await readFile(new URL(file, migrations), "utf8"));
}, 20_000);
afterAll(async () => {
	setOmhMailTransport(null);
	await postgres.close();
});
beforeEach(async () => {
	await postgres.exec("TRUNCATE rate_limit_records, history_access_links CASCADE");
	privateCalls = 0;
	mails = [];
	mailAnswer = undefined;
	failQuery = undefined;
});
afterEach(() => vi.useRealTimers());

describe("administrator login mail budget", () => {
	it("sends at most four login mails to the administrator in 24 hours, answering every request alike", async () => {
		for (let attempt = 1; attempt <= 5; attempt += 1)
			await expect(login(owner, `203.0.113.${attempt}`)).resolves.toBeUndefined();
		expect(mails).toHaveLength(4);
		// The fifth request was over the budget and changed nothing: the count is the four units out.
		expect(await budgetRows()).toEqual([{ attempts: ADMIN_LOGIN_MAILS_PER_DAY }]);
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
		expect(await budgetRows()).toEqual([{ attempts: ADMIN_LOGIN_MAILS_PER_DAY }]);
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
});

/**
 * The budget protects the project's daily sends from anyone who types the administrator's address,
 * so a unit comes back only when it is proven that no mail left: the gateway refused the message
 * before it contacted the mail provider (this includes the project's daily cap), or the request
 * failed before a send was attempted. An answer that leaves it open whether the mail was sent
 * keeps the unit spent, and so does a rejected message.
 */
describe("the unit of a login mail whose send the platform refused", () => {
	it.each([
		[403, "gateway_not_enabled", "gateway_not_enabled"],
		[403, "gateway_route_denied", "gateway_route_denied"],
		[429, "gateway_rate_limited", "gateway_rate_limited"],
		[400, "invalid_request", "gateway_request_invalid"],
		[401, "unauthorized", "unauthorized"],
		[402, "paid_plan_required", "paid_plan_required"],
		[402, "insufficient_organization_credits", "insufficient_organization_credits"],
		[402, "project_budget_exceeded", "project_budget_exceeded"],
		[423, "mail_reputation_suspended", "mail_reputation_suspended"],
		// Refused before the provider, like the others. The cap resets at 00:00 UTC while the budget
		// window runs 24 hours from the first request, so a unit kept here would outlive its cause.
		[429, "mail_send_daily_limit", "mail_send_limit_exceeded"],
	] as const)("gives the unit back after the gateway refused with %i %s", async (status, code, reason) => {
		mailAnswer = () => Response.json({ code }, { status });
		await expect(login()).rejects.toMatchObject({ code: reason });
		expect(await budgetRows()).toEqual([{ attempts: 0 }]);
		// Seven calls up to the refused send, one more to give the unit back; two spare.
		expect(privateCalls).toBe(8);
	});

	it("gives the unit back when the client refuses a misconfigured gateway key before any request", async () => {
		const misconfigured = { ...env, OHMYHOST_MAIL_KEY: "too-short" } as unknown as Env;
		await expect(login(owner, "203.0.113.1", misconfigured)).rejects.toMatchObject({
			code: "gateway_configuration_invalid",
		});
		expect(mails).toHaveLength(0);
		expect(await budgetRows()).toEqual([{ attempts: 0 }]);
	});

	it("keeps the unit spent when the message is rejected as unacceptable", async () => {
		mailAnswer = () => Response.json({ code: "mail_rejected" }, { status: 502 });
		await expect(login()).rejects.toMatchObject({ code: "mail_rejected" });
		expect(await budgetRows()).toEqual([{ attempts: 1 }]);
		expect(privateCalls).toBe(7);
	});

	it("lets the administrator in on the next UTC day after the daily cap refused every request of the evening", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-22T21:00:00Z"));
		mailAnswer = () => Response.json({ code: "mail_send_daily_limit" }, { status: 429 });
		for (let attempt = 1; attempt <= 4; attempt += 1)
			await expect(login(owner, `203.0.113.${attempt}`)).rejects.toMatchObject({
				code: "mail_send_limit_exceeded",
			});
		expect(mails.filter((mail) => mail.accepted)).toHaveLength(0);
		// The cap reset at 00:00 UTC, three hours into the budget's 24 hour window.
		vi.setSystemTime(new Date("2026-10-23T00:01:00Z"));
		mailAnswer = undefined;
		await expect(login(owner, "203.0.113.9")).resolves.toBeUndefined();
		expect(mails.filter((mail) => mail.accepted)).toEqual([{ to: owner, accepted: true }]);
	});

	describe("a request that fails before it asks the gateway to send", () => {
		it("gives the unit back when the link cannot be stored", async () => {
			failQuery = (query) => query.text.includes('insert into "history_access_links"');
			await expect(login()).rejects.toThrow();
			expect(mails).toHaveLength(0);
			expect(await budgetRows()).toEqual([{ attempts: 0 }]);
		});

		it("shows the failure that stopped the request when handing the unit back fails as well", async () => {
			const misconfigured = { ...env, APP_BASE_URL: "sign.amerged.com" } as unknown as Env;
			failQuery = (query) => query.text.includes("greatest(");
			await expect(login(owner, "203.0.113.1", misconfigured)).rejects.toThrow("Invalid URL");
			expect(await budgetRows()).toEqual([{ attempts: 1 }]);
		});

		it("gives the unit back when the app's own address cannot be turned into a link", async () => {
			// No scheme: new URL() throws before any mail exists.
			const misconfigured = { ...env, APP_BASE_URL: "sign.amerged.com" } as unknown as Env;
			await expect(login(owner, "203.0.113.1", misconfigured)).rejects.toThrow("Invalid URL");
			expect(mails).toHaveLength(0);
			expect(await budgetRows()).toEqual([{ attempts: 0 }]);
			// With the address corrected, the next request is not locked out for the rest of the window.
			await expect(login(owner, "203.0.113.2")).resolves.toBeUndefined();
			expect(mails).toHaveLength(1);
		});
	});

	it("lets the platform's refusal escape although handing the unit back failed too", async () => {
		mailAnswer = () => Response.json({ code: "paid_plan_required" }, { status: 402 });
		failQuery = (query) => query.text.includes("greatest(");
		// The hand-back is an update that fails like a call limit; the caller still sees the refusal.
		await expect(login()).rejects.toMatchObject({ code: "paid_plan_required" });
		// The unit stays spent: the hand-back is best effort.
		expect(await budgetRows()).toEqual([{ attempts: 1 }]);
	});

	it.each([
		[
			"the gateway answers that it is unavailable",
			() => Response.json({ code: "mail_gateway_unavailable" }, { status: 503 }),
			{ code: "gateway_unavailable" },
		],
		[
			"the request fails on the way",
			() => {
				throw new TypeError("network lost");
			},
			{ code: "gateway_unavailable" },
		],
		[
			"the answer cannot be read",
			() => new Response("upstream failure", { status: 502 }),
			{ code: "gateway_response_invalid" },
		],
		[
			"the gateway cannot yet say whether it sent the mail",
			() =>
				Response.json(
					{ state: "uncertain", request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW" },
					{ status: 202 },
				),
			{ name: MailDeliveryUncertainError.name },
		],
	] as const)("keeps the unit spent when %s, because the mail may have been sent", async (_case, answer, failure) => {
		mailAnswer = answer;
		await expect(login()).rejects.toMatchObject(failure);
		expect(await budgetRows()).toEqual([{ attempts: 1 }]);
		expect(privateCalls).toBe(7);
	});

	it("never counts the same unit back twice", async () => {
		const [first, second] = await withDatabase({ OHMYHOST_DATABASE: binding }, async () => [
			await takeAdminLoginMailBudget({ email: owner, now: new Date() }),
			await takeAdminLoginMailBudget({ email: owner, now: new Date() }),
		]);
		expect(await budgetRows()).toEqual([{ attempts: 2 }]);
		await first?.giveBack();
		await first?.giveBack();
		await Promise.all([first?.giveBack(), first?.giveBack()]);
		// One unit came back although the first grant was given back four times.
		expect(await budgetRows()).toEqual([{ attempts: 1 }]);
		await second?.giveBack();
		expect(await budgetRows()).toEqual([{ attempts: 0 }]);
	});

	it("gives a unit back only into the window it was taken from", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-22T08:00:00Z"));
		const old = await withDatabase({ OHMYHOST_DATABASE: binding }, () =>
			takeAdminLoginMailBudget({ email: owner, now: new Date() }),
		);
		// The 24 hour window ended while that send was still in flight; a new one has begun.
		vi.setSystemTime(new Date("2026-10-23T08:00:01Z"));
		const fresh = await withDatabase({ OHMYHOST_DATABASE: binding }, () =>
			takeAdminLoginMailBudget({ email: owner, now: new Date() }),
		);
		await old?.giveBack();
		expect(await budgetRows()).toEqual([{ attempts: 1 }]);
		await fresh?.giveBack();
		expect(await budgetRows()).toEqual([{ attempts: 0 }]);
	});

	it("keeps the count exact when units are taken and given back at the same time", async () => {
		const take = () =>
			withDatabase({ OHMYHOST_DATABASE: binding }, () =>
				takeAdminLoginMailBudget({ email: owner, now: new Date() }),
			);
		// Twelve requests at once: four get a unit. Each of them is refused by the platform and gives
		// its unit back while the others are still being served.
		const outcomes = await Promise.all(
			Array.from({ length: 12 }, async () => {
				const grant = await take();
				await grant?.giveBack();
				return grant !== null;
			}),
		);
		const granted = outcomes.filter(Boolean).length;
		expect(granted).toBeLessThanOrEqual(ADMIN_LOGIN_MAILS_PER_DAY);
		// Only a grant counts and every grant was given back once: nothing is left, and the count
		// never goes below zero.
		expect(await budgetRows()).toEqual([{ attempts: 0 }]);
	});

	it("lets the next request through after a burst whose every send was refused", async () => {
		const take = () =>
			withDatabase({ OHMYHOST_DATABASE: binding }, () =>
				takeAdminLoginMailBudget({ email: owner, now: new Date() }),
			);
		// More requests than units arrive together: the ones over the budget are turned away and must
		// leave no trace, or the units handed back below would not add up to an empty budget.
		const burst = await Promise.all(Array.from({ length: 12 }, take));
		expect(burst.filter(Boolean)).toHaveLength(ADMIN_LOGIN_MAILS_PER_DAY);
		for (const grant of burst) await grant?.giveBack();
		expect(await budgetRows()).toEqual([{ attempts: 0 }]);
		expect(await take()).not.toBeNull();
	});

	it("does not let repeated refused requests use up the budget of the address", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-22T08:00:00Z"));
		mailAnswer = () => Response.json({ code: "paid_plan_required" }, { status: 402 });
		for (let round = 0; round < 4; round += 1) {
			for (let attempt = 0; attempt < 5; attempt += 1)
				await expect(login(owner, `203.0.113.${round}`)).rejects.toMatchObject({
					code: "paid_plan_required",
				});
			// The ten-minute limiter of five requests has run out; wait for its window to pass.
			vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
		}
		expect(await budgetRows()).toEqual([{ attempts: 0 }]);
		mailAnswer = undefined;
		await expect(login(owner, "203.0.113.50")).resolves.toBeUndefined();
		expect(mails.at(-1)).toEqual({ to: owner, accepted: true });
		expect(await budgetRows()).toEqual([{ attempts: 1 }]);
	});

	it("still sends at most four mails in 24 hours when a gateway mails and then fails to say so", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-22T08:00:00Z"));
		// Every request that reaches this gateway is a real mail, whatever it answers.
		mailAnswer = () => Response.json({ code: "mail_gateway_unavailable" }, { status: 503 });
		const failures: unknown[] = [];
		for (let round = 0; round < 4; round += 1) {
			for (let attempt = 0; attempt < 5; attempt += 1)
				await login(owner, `203.0.113.${round}`).catch((error: unknown) => failures.push(error));
			vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
		}
		// Twenty requests over 44 minutes: the first four failed after a send, the others took no
		// unit and reached no gateway.
		expect(failures).toHaveLength(ADMIN_LOGIN_MAILS_PER_DAY);
		expect(mails).toHaveLength(ADMIN_LOGIN_MAILS_PER_DAY);
		expect(await budgetRows()).toEqual([{ attempts: ADMIN_LOGIN_MAILS_PER_DAY }]);
	});

	it("never lets refused and accepted sends together exceed four accepted mails in the window", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-22T08:00:00Z"));
		const refused = () => Response.json({ code: "project_budget_exceeded" }, { status: 402 });
		for (let round = 0; round < 6; round += 1) {
			mailAnswer = round % 2 === 0 ? refused : undefined;
			for (let attempt = 0; attempt < 3; attempt += 1)
				await login(owner, `203.0.113.${round}`).catch(() => undefined);
			vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
		}
		expect(mails.filter((mail) => mail.accepted)).toHaveLength(ADMIN_LOGIN_MAILS_PER_DAY);
	});

	it("keeps counting a refused request against the ten-minute request limiter", async () => {
		mailAnswer = () => Response.json({ code: "paid_plan_required" }, { status: 402 });
		for (let attempt = 0; attempt < 5; attempt += 1)
			await expect(login()).rejects.toMatchObject({ code: "paid_plan_required" });
		// The sixth request is stopped by the limiter before it takes a unit or asks the gateway.
		await expect(login()).rejects.toMatchObject({ name: "HistoryRequestRateLimitError" });
		expect(mails).toHaveLength(5);
		expect(
			(
				await postgres.query<{ attempts: number }>(
					"SELECT attempts FROM rate_limit_records WHERE operation='history-access-request' AND key = 'email:owner@example.com'",
				)
			).rows,
		).toEqual([{ attempts: 5 }]);
		expect(await budgetRows()).toEqual([{ attempts: 0 }]);
	});
});
