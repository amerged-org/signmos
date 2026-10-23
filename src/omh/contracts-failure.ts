import { CustomerRuntimeError } from "@ohmyhost/customer-runtime";
import { DrizzleQueryError } from "drizzle-orm";
import { EmailDeliveryError } from "@/db/envelope";
import { ContractError } from "./contracts-schema";
import { MailDeliveryUncertainError } from "./mail";

const DRAFT_KEPT = "The draft was kept and its signing link stays inactive.";

/** The step of creation a platform call belonged to; the platform's error codes do not name it. */
export type CreationPhase = "database" | "storage" | "mail" | "activation";

/** Marks the step of creation that raised `cause`, so that its failure can be worded for that step. */
export class CreationPhaseError extends Error {
	constructor(
		public readonly phase: CreationPhase,
		cause: unknown,
	) {
		super(`Contract creation failed in the ${phase} step`, { cause });
		this.name = "CreationPhaseError";
	}
}

/**
 * What a caller rethrows when a failure is not recorded: the platform's own error. The API error
 * handler reads its code, and neither the step marker nor drizzle's query error, which wraps what
 * the platform client raised for a statement it built (its text carries SQL), shows it.
 */
export function unwrapFailure(error: unknown): unknown {
	if (error instanceof CreationPhaseError || error instanceof DrizzleQueryError)
		return error.cause === undefined ? error : unwrapFailure(error.cause);
	return error;
}

/**
 * Failures after a command is claimed that are known well enough to record, replay and explain.
 * The platform's clients raise typed errors (the hosted Worker keeps no console output, so the
 * response is the only place the operator sees the cause); anything else is a bug and escapes.
 */
export function contractFailure(error: unknown): ContractError | null {
	if (error instanceof CreationPhaseError) return failureAt(error.phase, error.cause);
	return failureAt(null, error);
}

function failureAt(phase: CreationPhase | null, error: unknown): ContractError | null {
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
	return error instanceof CustomerRuntimeError ? runtimeFailure(error.code, phase) : null;
}

/** What is known when a platform call did not answer depends on how far creation had got. */
function unconfirmed(phase: CreationPhase | null): string {
	switch (phase) {
		case "database":
			return "The platform database did not confirm saving the draft; nothing was uploaded and no invitation was sent. Create a new request with a new Idempotency-Key.";
		case "storage":
			return `The platform file storage did not confirm the PDF upload; no invitation was sent. ${DRAFT_KEPT} Create a new request with a new Idempotency-Key.`;
		case "activation":
			return "The invitation was sent, but the platform database did not confirm activating its signing link, so the link may not work. Check the contract list: if the contract is still a draft, create a new request with a new Idempotency-Key; the recipient then receives a second email.";
		default:
			// The mail step, or a call outside any step.
			return `A platform service did not confirm the request, so the invitation may or may not have been delivered. ${DRAFT_KEPT} Check the contract list, then create a new request with a new Idempotency-Key.`;
	}
}

/** Every recorded runtime failure carries the platform client's code as its `reason`. */
function runtimeFailure(
	code: CustomerRuntimeError["code"],
	phase: CreationPhase | null,
): ContractError | null {
	const refuse = (apiCode: string, message: string, status: ContractError["status"]) =>
		new ContractError(apiCode, message, status, code);
	switch (code) {
		case "mail_send_limit_exceeded":
			return refuse(
				"MAIL_DAILY_LIMIT",
				`The project's daily email limit is reached; no invitation was sent. ${DRAFT_KEPT} Create a new request with a new Idempotency-Key after 00:00 UTC.`,
				429,
			);
		case "mail_reputation_suspended":
			return refuse(
				"MAIL_SENDER_SUSPENDED",
				`Sending is suspended for this project after bounces or complaints; no invitation was sent. ${DRAFT_KEPT} Report it to ohmyho.st before creating a new request.`,
				423,
			);
		case "paid_plan_required":
			return refuse(
				"PAID_PLAN_REQUIRED",
				`Sending email needs a Paid workspace; no invitation was sent. ${DRAFT_KEPT} Start Paid, then create a new request with a new Idempotency-Key.`,
				402,
			);
		case "insufficient_organization_credits":
			return refuse(
				"INSUFFICIENT_ORGANIZATION_CREDITS",
				`The workspace has no credits left to send email; no invitation was sent. ${DRAFT_KEPT} Add credits, then create a new request with a new Idempotency-Key.`,
				402,
			);
		case "project_budget_exceeded":
			return refuse(
				"PROJECT_BUDGET_EXCEEDED",
				`The project's Stop budget is used up; no invitation was sent. ${DRAFT_KEPT} Raise the budget, then create a new request with a new Idempotency-Key.`,
				402,
			);
		case "mail_rejected":
			return refuse(
				"EMAIL_DELIVERY_FAILED",
				"The mail provider refused the invitation. Review the draft before sending a new request.",
				502,
			);
		case "gateway_configuration_invalid":
		case "gateway_request_invalid":
		case "unauthorized":
			return refuse(
				"PLATFORM_CONFIGURATION_INVALID",
				`A platform service refused the request, usually a sender address that the project's mail binding does not list, or a missing key; no invitation was sent. ${DRAFT_KEPT}`,
				503,
			);
		case "gateway_response_invalid":
		case "gateway_timeout":
		case "gateway_unavailable":
		case "database_unavailable":
			return refuse("PLATFORM_SERVICE_UNAVAILABLE", unconfirmed(phase), 503);
		default:
			return null;
	}
}
