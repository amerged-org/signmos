import { CustomerRuntimeError, CustomerRuntimeGatewayError } from "@ohmyhost/customer-runtime";
import { EmailDeliveryError } from "@/db/envelope";
import { contractFailure } from "./contracts-failure";
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
