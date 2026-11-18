import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { fingerprintAgentCommand } from "@/db/agentic-access";
import { agenticCommandRecords } from "@/db/agentic-access/table";
import type { EmailDeliveryEnv } from "@/db/envelope";
import { getDb } from "@/db/setup";
import { createHono } from "@/hono/factory";
import { resolveAdminRequest } from "@/omh/auth";
import { renderHtmlContract } from "@/omh/contracts-browser-pdf";
import {
	claimContractCommand,
	contractCommandPrincipal,
	reconcileContractCommand,
} from "@/omh/contracts-command";
import {
	PatchContractSchema,
	readContractJson,
	readDraftContract,
	SendContractSchema,
} from "@/omh/contracts-draft-schema";
import {
	createClaimedContractDraft,
	patchClaimedContractDraft,
	replaceClaimedContractPdf,
} from "@/omh/contracts-drafts";
import {
	cancelClaimedContract,
	deleteClaimedContractDraft,
	sendClaimedContract,
} from "@/omh/contracts-lifecycle";
import { ContractError } from "@/omh/contracts-schema";
import { commandClaimResponse } from "./agent-v1-command-helpers";

const endpoint = createHono();
type Action = "create" | "patch" | "replace" | "send" | "cancel" | "delete";
const operations: Record<Action, string> = {
	create: "contracts.drafts.create",
	patch: "contracts.drafts.patch",
	replace: "contracts.pdf.replace",
	send: "contracts.send",
	cancel: "contracts.cancel",
	delete: "contracts.drafts.delete",
};
endpoint.post("/drafts", handle("create"));
endpoint.patch("/:id", handle("patch"));
endpoint.put("/:id/pdf", handle("replace"));
endpoint.post("/:id/send", handle("send"));
endpoint.post("/:id/cancel", handle("cancel"));
endpoint.delete("/:id", handle("delete"));

function handle(action: Action) {
	return async (c: Context<{ Bindings: Env }>): Promise<Response> => {
		const auth = await resolveAdminRequest(c.req.raw, c.env, { allowBearer: true });
		if (!auth.ok) return auth.response;
		const key = c.req.header("idempotency-key")?.trim();
		if (!key || key.length > 200)
			return errorResponse(
				new ContractError(
					"IDEMPOTENCY_KEY_REQUIRED",
					"Supply an Idempotency-Key header of at most 200 characters",
				),
			);
		const id = action === "create" ? "" : (c.req.param("id") ?? "");
		if (action !== "create" && !z.uuid().safeParse(id).success)
			return errorResponse(new ContractError("CONTRACT_NOT_FOUND", "Contract not found", 404));
		let recordId: string | undefined;
		try {
			const request =
				action === "create" || action === "replace"
					? await readDraftContract(c.req.raw, action === "create")
					: null;
			const patch =
				action === "patch"
					? PatchContractSchema.safeParse(await readContractJson(c.req.raw))
					: null;
			if (patch && !patch.success)
				throw new ContractError(
					"INVALID_CONTRACT",
					"Supply valid draft metadata, recipients or field definitions",
				);
			const send =
				action === "send" ? SendContractSchema.safeParse(await readContractJson(c.req.raw)) : null;
			if (send && !send.success)
				throw new ContractError("INVALID_CONTRACT", "Select delivery=email or delivery=manual");
			if (action === "cancel" && c.req.raw.body) {
				const cancellation = z
					.object({})
					.strict()
					.safeParse(await readContractJson(c.req.raw));
				if (!cancellation.success)
					throw new ContractError("INVALID_CONTRACT", "Cancel accepts an empty object");
			}
			const principal = await contractCommandPrincipal(auth.principal);
			const claim = await claimContractCommand({
				principal,
				idempotencyKey: key,
				operation: operations[action],
				requestFingerprint: await fingerprintAgentCommand({
					id,
					request,
					patch: patch?.success ? patch.data : null,
					send: send?.success ? send.data : null,
				}),
			});
			if (claim.state !== "execute")
				return withDeletionRetryHeader(
					commandClaimResponse(claim),
					claim.state === "replay" ? claim.body : undefined,
				);
			recordId = claim.recordId;
			const command = { recordId, email: auth.principal.email };
			const env = c.env as Env & EmailDeliveryEnv & { DOCUMENTS_BUCKET?: R2Bucket };
			const storage = () => {
				if (!env.DOCUMENTS_BUCKET)
					throw new ContractError("STORAGE_UNAVAILABLE", "Document storage is not configured", 503);
				return env.DOCUMENTS_BUCKET;
			};
			if (action === "create" && request)
				return c.json(
					{
						data: await createClaimedContractDraft({
							...command,
							request: "html" in request ? await renderHtmlContract(request, env) : request,
							documentsBucket: storage(),
						}),
					},
					201,
				);
			if (action === "replace" && request && "pdf" in request)
				return c.json({
					data: await replaceClaimedContractPdf({
						...command,
						id,
						request,
						documentsBucket: storage(),
					}),
				});
			if (action === "patch" && patch?.success)
				return c.json({
					data: await patchClaimedContractDraft({
						...command,
						id,
						patch: patch.data,
						documentsBucket: storage(),
					}),
				});
			if (action === "send" && send?.success) {
				const data = await sendClaimedContract({
					...command,
					id,
					delivery: send.data.delivery,
					emailDelivery: { env, baseUrl: env.APP_BASE_URL?.trim() || new URL(c.req.url).origin },
				});
				return c.json({ data }, send.data.delivery === "email" ? 202 : 200);
			}
			if (action === "cancel")
				return c.json({ data: await cancelClaimedContract({ ...command, id }) });
			if (action === "delete")
				return c.json({
					data: await deleteClaimedContractDraft({ ...command, id, documentsBucket: storage() }),
				});
			throw new ContractError("INVALID_CONTRACT", "Invalid contract operation");
		} catch (error) {
			if (!(error instanceof ContractError)) {
				if (recordId) return reconcileContractCommand(recordId);
				throw error;
			}
			const body = contractErrorBody(error);
			if (recordId)
				await getDb()
					.update(agenticCommandRecords)
					.set({
						state: "completed",
						responseStatus: error.status,
						responseBody: JSON.stringify(body),
						completedAt: new Date(),
					})
					.where(
						and(eq(agenticCommandRecords.id, recordId), eq(agenticCommandRecords.state, "pending")),
					);
			return errorResponse(error);
		}
	};
}
function errorResponse(error: ContractError): Response {
	const body = contractErrorBody(error);
	return withDeletionRetryHeader(Response.json(body, { status: error.status }), body);
}
function contractErrorBody(error: ContractError) {
	return { error: { code: error.code, message: error.message, ...error.details } };
}
function withDeletionRetryHeader(response: Response, body: unknown): Response {
	if (!body || typeof body !== "object" || !("error" in body)) return response;
	const error = body.error;
	if (
		!error ||
		typeof error !== "object" ||
		!("code" in error) ||
		error.code !== "STORAGE_DELETE_PENDING" ||
		!("retryAt" in error) ||
		typeof error.retryAt !== "string"
	)
		return response;
	const retryAt = Date.parse(error.retryAt);
	if (Number.isFinite(retryAt))
		response.headers.set("Retry-After", new Date(Math.ceil(retryAt / 1000) * 1000).toUTCString());
	return response;
}
export default endpoint;
