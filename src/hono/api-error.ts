import { CustomerDatabaseError, CustomerRuntimeError } from "@ohmyhost/customer-runtime";
import { HTTPException } from "hono/http-exception";

/**
 * Every unexpected API failure answers JSON. A hosted Worker keeps no console output, so the
 * stable code of a platform client error is the only diagnostic the administrator gets; its
 * message and SQL are never returned. Call-limit and timeout failures surface as the clients'
 * retryable codes.
 *
 * The code goes only to the administrator. A refusal such as `paid_plan_required`,
 * `insufficient_organization_credits`, `project_budget_exceeded` or `mail_reputation_suspended`
 * names the sender's plan, credit, budget or reputation, and a signer or the holder of a download
 * link reaches the same handler: for them the answer stays the same failure without the code.
 */
export function apiErrorResponse(error: unknown, audience: { administrator: boolean }): Response {
	if (error instanceof HTTPException) return error.getResponse();
	const headers = { "cache-control": "no-store" };
	const reason = (code: string) => (audience.administrator ? { reason: code } : {});
	if (error instanceof CustomerRuntimeError)
		return Response.json(
			{
				error: {
					code: "PLATFORM_SERVICE_ERROR",
					message: "A platform service failed. Retry only if it is marked retryable.",
					...reason(error.code),
					retryable: error.retryable,
				},
			},
			{ status: error.retryable ? 503 : 500, headers },
		);
	if (error instanceof CustomerDatabaseError)
		return Response.json(
			{
				error: {
					code: "DATABASE_ERROR",
					message: "The database rejected the request.",
					...reason(error.code),
					retryable: error.retryable,
				},
			},
			{ status: error.retryable ? 503 : 500, headers },
		);
	return Response.json(
		{ error: { code: "INTERNAL_ERROR", message: "Internal Server Error", retryable: false } },
		{ status: 500, headers },
	);
}
