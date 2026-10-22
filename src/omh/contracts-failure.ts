import { CustomerRuntimeError } from "@ohmyhost/customer-runtime";
import { EmailDeliveryError } from "@/db/envelope";
import { ContractError } from "./contracts-schema";
import { MailDeliveryUncertainError } from "./mail";

const DRAFT_KEPT = "The draft was kept and its signing link stays inactive.";

/**
 * Failures after a command is claimed that are known well enough to record, replay and explain.
 * The platform's clients raise typed errors (the hosted Worker keeps no console output, so the
 * response is the only place the operator sees the cause); anything else is a bug and escapes.
 */
export function contractFailure(error: unknown): ContractError | null {
	if (error instanceof ContractError) return error;
	if (error instanceof EmailDeliveryError)
		return new ContractError(
			"EMAIL_DELIVERY_FAILED",
			"The invitation could not be confirmed as delivered. Review the draft before sending a new request.",
			502,
		);
	if (error instanceof MailDeliveryUncertainError)
		return new ContractError(
			"EMAIL_DELIVERY_UNCERTAIN",
			`The invitation may or may not have been delivered. ${DRAFT_KEPT} Check with the recipient, then create a new request with a new Idempotency-Key.`,
			503,
		);
	return error instanceof CustomerRuntimeError ? runtimeFailure(error.code) : null;
}

function runtimeFailure(code: CustomerRuntimeError["code"]): ContractError | null {
	switch (code) {
		case "mail_send_limit_exceeded":
			return new ContractError(
				"MAIL_DAILY_LIMIT",
				`The project's daily email limit is reached; no invitation was sent. ${DRAFT_KEPT} Create a new request with a new Idempotency-Key after 00:00 UTC.`,
				429,
			);
		case "mail_reputation_suspended":
			return new ContractError(
				"MAIL_SENDER_SUSPENDED",
				`Sending is suspended for this project after bounces or complaints; no invitation was sent. ${DRAFT_KEPT} Report it to ohmyho.st before creating a new request.`,
				423,
			);
		case "paid_plan_required":
			return new ContractError(
				"PAID_PLAN_REQUIRED",
				`Sending email needs a Paid workspace; no invitation was sent. ${DRAFT_KEPT} Start Paid, then create a new request with a new Idempotency-Key.`,
				402,
			);
		case "insufficient_organization_credits":
			return new ContractError(
				"INSUFFICIENT_ORGANIZATION_CREDITS",
				`The workspace has no credits left to send email; no invitation was sent. ${DRAFT_KEPT} Add credits, then create a new request with a new Idempotency-Key.`,
				402,
			);
		case "project_budget_exceeded":
			return new ContractError(
				"PROJECT_BUDGET_EXCEEDED",
				`The project's Stop budget is used up; no invitation was sent. ${DRAFT_KEPT} Raise the budget, then create a new request with a new Idempotency-Key.`,
				402,
			);
		case "mail_rejected":
			return new ContractError(
				"EMAIL_DELIVERY_FAILED",
				"The mail provider refused the invitation. Review the draft before sending a new request.",
				502,
			);
		case "gateway_configuration_invalid":
		case "gateway_request_invalid":
		case "unauthorized":
			return new ContractError(
				"PLATFORM_CONFIGURATION_INVALID",
				`A platform service refused the request, usually a sender address that the project's mail binding does not list, or a missing key; no invitation was sent. ${DRAFT_KEPT}`,
				503,
			);
		case "gateway_response_invalid":
		case "gateway_timeout":
		case "gateway_unavailable":
		case "database_unavailable":
			return new ContractError(
				"PLATFORM_SERVICE_UNAVAILABLE",
				`A platform service did not confirm the request, so the invitation may or may not have been delivered. ${DRAFT_KEPT} Check the contract list, then create a new request with a new Idempotency-Key.`,
				503,
			);
		default:
			return null;
	}
}
