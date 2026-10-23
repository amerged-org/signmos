import { CustomerRuntimeError, CustomerRuntimeGatewayError } from "@ohmyhost/customer-runtime";
import { DrizzleQueryError } from "drizzle-orm";
import { EmailDeliveryError } from "@/db/envelope";
import { CreationPhaseError, contractFailure } from "./contracts-failure";
import { ContractError } from "./contracts-schema";
import { MailDeliveryUncertainError } from "./mail";

const gateway = (code: ConstructorParameters<typeof CustomerRuntimeGatewayError>[0]) =>
	new CustomerRuntimeGatewayError(code, null, false);

describe("recordable contract creation failures", () => {
	it.each([
		["mail_send_limit_exceeded", 429, "MAIL_DAILY_LIMIT"],
		["mail_reputation_suspended", 423, "MAIL_SENDER_SUSPENDED"],
		["paid_plan_required", 402, "PAID_PLAN_REQUIRED"],
		["insufficient_organization_credits", 402, "INSUFFICIENT_ORGANIZATION_CREDITS"],
		["project_budget_exceeded", 402, "PROJECT_BUDGET_EXCEEDED"],
		["mail_rejected", 502, "EMAIL_DELIVERY_FAILED"],
		["gateway_request_invalid", 503, "PLATFORM_CONFIGURATION_INVALID"],
		["gateway_configuration_invalid", 503, "PLATFORM_CONFIGURATION_INVALID"],
		["unauthorized", 503, "PLATFORM_CONFIGURATION_INVALID"],
		["gateway_unavailable", 503, "PLATFORM_SERVICE_UNAVAILABLE"],
		["gateway_timeout", 503, "PLATFORM_SERVICE_UNAVAILABLE"],
		["gateway_response_invalid", 503, "PLATFORM_SERVICE_UNAVAILABLE"],
	] as const)("maps the platform code %s to HTTP %i %s", (code, status, apiCode) => {
		const failure = contractFailure(gateway(code));
		expect(failure).toBeInstanceOf(ContractError);
		expect(failure).toMatchObject({ status, code: apiCode });
		expect(failure?.message.length).toBeGreaterThan(20);
		expect(failure?.message).not.toContain("\n");
	});

	it("maps a database outage and keeps typed application errors", () => {
		expect(contractFailure(new CustomerRuntimeError("database_unavailable", true))).toMatchObject({
			status: 503,
			code: "PLATFORM_SERVICE_UNAVAILABLE",
		});
		const known = new ContractError("INVALID_FIELDS", "bad", 400);
		expect(contractFailure(known)).toBe(known);
		expect(contractFailure(new EmailDeliveryError(502, "provider"))).toMatchObject({
			status: 502,
			code: "EMAIL_DELIVERY_FAILED",
		});
		expect(contractFailure(new MailDeliveryUncertainError())).toMatchObject({
			status: 503,
			code: "EMAIL_DELIVERY_UNCERTAIN",
		});
	});

	it("leaves bugs and codes without a recorded meaning to the caller", () => {
		expect(contractFailure(new TypeError("boom"))).toBeNull();
		expect(contractFailure(gateway("storage_conflict"))).toBeNull();
		expect(contractFailure(new CustomerRuntimeError("database_query_invalid", false))).toBeNull();
		expect(contractFailure("text")).toBeNull();
	});
});

describe("platform codes as the recorded reason", () => {
	it.each([
		"mail_send_limit_exceeded",
		"mail_reputation_suspended",
		"paid_plan_required",
		"insufficient_organization_credits",
		"project_budget_exceeded",
		"mail_rejected",
		"gateway_request_invalid",
		"gateway_configuration_invalid",
		"unauthorized",
		"gateway_unavailable",
		"gateway_timeout",
		"gateway_response_invalid",
	] as const)("records %s as the reason, and only the code", (code) => {
		const failure = contractFailure(
			new CustomerRuntimeGatewayError(code, 503, true, "detail that must stay out of the body"),
		);
		expect(failure?.reason).toBe(code);
		expect(JSON.stringify([failure?.message, failure?.reason])).not.toContain("detail that");
	});

	it("records the database outage code, and leaves application errors without a reason", () => {
		expect(contractFailure(new CustomerRuntimeError("database_unavailable", true))?.reason).toBe(
			"database_unavailable",
		);
		expect(
			contractFailure(new ContractError("INVALID_FIELDS", "bad", 400))?.reason,
		).toBeUndefined();
		expect(contractFailure(new EmailDeliveryError(502, "provider"))?.reason).toBeUndefined();
		expect(contractFailure(new MailDeliveryUncertainError())?.reason).toBeUndefined();
	});
});

describe("which step of creation an unconfirmed platform call interrupted", () => {
	const unconfirmed = [
		"gateway_response_invalid",
		"gateway_timeout",
		"gateway_unavailable",
		"database_unavailable",
	] as const;

	it.each([
		[
			"database",
			[/did not confirm saving the draft/, /nothing was uploaded/, /no invitation was sent/],
			[/may or may not have been delivered/, /draft was kept/, /second email/],
		],
		[
			"storage",
			[
				/file storage did not confirm the PDF upload/,
				/no invitation was sent/,
				/draft was kept and its signing link stays inactive/,
			],
			[/may or may not have been delivered/, /nothing was uploaded/, /second email/],
		],
		[
			"mail",
			[/may or may not have been delivered/, /draft was kept and its signing link stays inactive/],
			[/nothing was uploaded/, /file storage/, /second email/],
		],
		[
			"activation",
			[
				/invitation was sent/,
				/did not confirm activating its signing link/,
				/link may not work/,
				/second email/,
			],
			[/no invitation was sent/, /may or may not have been delivered/, /stays inactive/],
		],
	] as const)("words a %s failure for what is known at that step", (phase, says, doesNotSay) => {
		for (const code of unconfirmed) {
			const failure = contractFailure(
				new CreationPhaseError(phase, new CustomerRuntimeError(code, true)),
			);
			expect(failure, code).toMatchObject({
				status: 503,
				code: "PLATFORM_SERVICE_UNAVAILABLE",
				reason: code,
			});
			for (const pattern of says) expect(failure?.message, code).toMatch(pattern);
			for (const pattern of doesNotSay) expect(failure?.message, code).not.toMatch(pattern);
			expect(failure?.message).not.toContain("\n");
		}
	});

	it("keeps the mail wording for a call outside any step", () => {
		expect(contractFailure(gateway("gateway_timeout"))?.message).toMatch(
			/may or may not have been delivered/,
		);
	});

	it.each([
		"database",
		"storage",
		"mail",
		"activation",
	] as const)("maps refusals that say what happened the same way in the %s step", (phase) => {
		expect(
			contractFailure(new CreationPhaseError(phase, gateway("mail_send_limit_exceeded"))),
		).toMatchObject({ status: 429, code: "MAIL_DAILY_LIMIT", reason: "mail_send_limit_exceeded" });
		expect(
			contractFailure(new CreationPhaseError(phase, new EmailDeliveryError(502, "provider"))),
		).toMatchObject({ status: 502, code: "EMAIL_DELIVERY_FAILED" });
		const known = new ContractError("INVALID_FIELDS", "bad", 400);
		expect(contractFailure(new CreationPhaseError(phase, known))).toBe(known);
	});

	it("leaves bugs and unmapped codes in any step to the caller", () => {
		for (const cause of [
			new TypeError("boom"),
			gateway("storage_conflict"),
			new CustomerRuntimeError("database_query_invalid", false),
		])
			expect(contractFailure(new CreationPhaseError("database", cause))).toBeNull();
	});
});

describe("a failure behind the query layer's wrapper", () => {
	const statement = 'update "agentic_command_records" set "state" = $1';
	/** Drizzle wraps whatever the platform client raised for a query it built, with SQL in its text. */
	const failedQuery = (cause?: Error) => new DrizzleQueryError(statement, ["secret"], cause);

	it("records the platform error behind two query errors, with the reason and the database wording", () => {
		const failure = contractFailure(
			new CreationPhaseError(
				"database",
				failedQuery(failedQuery(new CustomerRuntimeError("database_unavailable", true))),
			),
		);
		expect(failure).toBeInstanceOf(ContractError);
		expect(failure).toMatchObject({
			status: 503,
			code: "PLATFORM_SERVICE_UNAVAILABLE",
			reason: "database_unavailable",
		});
		expect(failure?.message).toMatch(/did not confirm saving the draft/);
		expect(failure?.message).not.toContain("agentic_command_records");
		expect(failure?.message).not.toContain("secret");
	});

	it.each([
		["database", /did not confirm saving the draft/],
		["storage", /file storage did not confirm the PDF upload/],
		["mail", /may or may not have been delivered/],
		["activation", /did not confirm activating its signing link/],
	] as const)("words a %s failure behind the wrapper like one without it", (phase, wording) => {
		const failure = contractFailure(
			new CreationPhaseError(phase, failedQuery(gateway("gateway_timeout"))),
		);
		expect(failure).toMatchObject({
			code: "PLATFORM_SERVICE_UNAVAILABLE",
			reason: "gateway_timeout",
		});
		expect(failure?.message).toMatch(wording);
	});

	it("records a refusal behind a plain error's cause as well", () => {
		const failure = contractFailure(
			new CreationPhaseError(
				"mail",
				new Error("the send failed", { cause: gateway("mail_send_limit_exceeded") }),
			),
		);
		expect(failure).toMatchObject({
			status: 429,
			code: "MAIL_DAILY_LIMIT",
			reason: "mail_send_limit_exceeded",
		});
	});

	it("records the platform error of a failure that carries no step marker", () => {
		expect(contractFailure(failedQuery(gateway("gateway_unavailable")))).toMatchObject({
			code: "PLATFORM_SERVICE_UNAVAILABLE",
			reason: "gateway_unavailable",
		});
	});

	it("leaves bugs and unmapped codes behind the wrapper to the caller", () => {
		for (const cause of [new TypeError("boom"), gateway("storage_conflict"), undefined])
			expect(contractFailure(new CreationPhaseError("database", failedQuery(cause)))).toBeNull();
	});
});
