import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { fingerprintAgentCommand } from "@/db/agentic-access";
import { agenticCommandRecords } from "@/db/agentic-access/table";
import { type EmailDeliveryEnv, isResendConfigured } from "@/db/envelope";
import { getDb } from "@/db/setup";
import { createHono } from "@/hono/factory";
import { resolveAdminRequest } from "@/omh/auth";
import { getContract, getContractFinalPdf, listContracts } from "@/omh/contracts";
import { claimContractCommand, contractCommandPrincipal } from "@/omh/contracts-command";
import { createAndSendClaimedContract } from "@/omh/contracts-create";
import { contractFailure, unwrapFailure } from "@/omh/contracts-failure";
import {
	ContractError,
	type CreateContractRequest,
	CreateContractSchema,
	MAX_CONTRACT_REQUEST_BYTES,
} from "@/omh/contracts-schema";
import { commandClaimResponse } from "./agent-v1-command-helpers";

const contractsEndpoint = createHono();
const ContractIdSchema = z.uuid();

contractsEndpoint.use("*", async (c, next) => {
	c.header("cache-control", "private, no-store");
	await next();
});

contractsEndpoint.get("/", async (c) => {
	const auth = await resolveAdminRequest(c.req.raw, c.env, { allowBearer: true });
	if (!auth.ok) return auth.response;
	return c.json({ data: await listContracts(auth.principal.email) });
});

contractsEndpoint.post("/", async (c) => {
	const auth = await resolveAdminRequest(c.req.raw, c.env, { allowBearer: true });
	if (!auth.ok) return auth.response;
	const key = c.req.header("idempotency-key")?.trim();
	if (!key || key.length > 200)
		return errorResponse(
			"IDEMPOTENCY_KEY_REQUIRED",
			"Supply an Idempotency-Key header of at most 200 characters",
			400,
		);
	const request = await validatedContractRequest(c.req.raw);
	if (request instanceof Response) return request;
	const env = c.env as Env & EmailDeliveryEnv & { DOCUMENTS_BUCKET?: R2Bucket };
	const principal = await contractCommandPrincipal(auth.principal);
	const claim = await claimContractCommand({
		principal,
		idempotencyKey: key,
		operation: "contracts.create-and-send",
		requestFingerprint: await fingerprintAgentCommand(request),
	});
	if (claim.state !== "execute") return commandClaimResponse(claim);
	try {
		if (!env.DOCUMENTS_BUCKET)
			throw new ContractError("STORAGE_UNAVAILABLE", "Document storage is not configured", 503);
		if (!isResendConfigured(env))
			throw new ContractError("EMAIL_UNAVAILABLE", "Email delivery is not configured", 503);
		const contract = await createAndSendClaimedContract({
			recordId: claim.recordId,
			email: auth.principal.email,
			request,
			documentsBucket: env.DOCUMENTS_BUCKET,
			emailDelivery: { env, baseUrl: env.APP_BASE_URL?.trim() || new URL(c.req.url).origin },
		});
		const body = { data: contract };
		return c.json(body, 201);
	} catch (error) {
		return completeFailedCommand(claim.recordId, error);
	}
});

contractsEndpoint.get("/:id/pdf", async (c) => {
	const auth = await resolveAdminRequest(c.req.raw, c.env, { allowBearer: true });
	if (!auth.ok) return auth.response;
	const id = ContractIdSchema.safeParse(c.req.param("id"));
	if (!id.success) return notFound();
	const document = await getContractFinalPdf(auth.principal.email, id.data);
	if (document.state === "not_found") return notFound();
	if (document.state === "not_completed")
		return errorResponse("FINAL_PDF_NOT_READY", "The contract has not been completed", 409);
	const bucket = (c.env as Env & { DOCUMENTS_BUCKET?: R2Bucket }).DOCUMENTS_BUCKET;
	const object = document.state === "ready" ? await bucket?.get(document.r2Key) : null;
	if (!object)
		return errorResponse("FINAL_PDF_UNAVAILABLE", "The final PDF is temporarily unavailable", 503);
	const bytes = await object.arrayBuffer();
	const current = await getContractFinalPdf(auth.principal.email, id.data);
	if (current.state !== "ready" || document.state !== "ready" || current.r2Key !== document.r2Key)
		return notFound();
	return new Response(bytes, {
		headers: {
			"content-type": "application/pdf",
			"cache-control": "private, no-store",
			"content-disposition": `attachment; filename="contract-${id.data}.pdf"`,
			"x-content-type-options": "nosniff",
		},
	});
});

contractsEndpoint.get("/:id", async (c) => {
	const auth = await resolveAdminRequest(c.req.raw, c.env, { allowBearer: true });
	if (!auth.ok) return auth.response;
	const id = ContractIdSchema.safeParse(c.req.param("id"));
	if (!id.success) return notFound();
	const contract = await getContract(auth.principal.email, id.data);
	return contract ? c.json({ data: contract }) : notFound();
});

async function validatedContractRequest(
	request: Request,
): Promise<CreateContractRequest | Response> {
	let json: unknown;
	try {
		json = await readContractJson(request);
	} catch (error) {
		return error instanceof ContractError
			? errorResponse(error.code, error.message, error.status)
			: errorResponse("INVALID_CONTRACT", "Supply a JSON contract request", 400);
	}
	const parsed = CreateContractSchema.safeParse(json);
	if (parsed.success) return parsed.data;
	const tooLarge = parsed.error.issues.find((issue) => issue.code === "too_big");
	if (tooLarge?.path.join(".") === "pdf.base64")
		return errorResponse("SOURCE_PDF_TOO_LARGE", "The source PDF must be at most 2 MiB", 413);
	if (tooLarge?.path.join(".") === "fields")
		return errorResponse(
			"SOURCE_PDF_TOO_MANY_FIELDS",
			"A document can have at most 20 signing fields",
			413,
		);

	return Response.json(
		{
			error: {
				code: "INVALID_CONTRACT",
				message:
					"Supply a title, one recipient and a PDF; optional fields use 612 by 792 coordinates",
				fields: parsed.error.issues.map((issue) => issue.path.join(".")),
			},
		},
		{ status: 400 },
	);
}

async function completeFailedCommand(recordId: string, error: unknown): Promise<Response> {
	const known = contractFailure(error);
	// An unrecorded failure reaches the API error handler as the platform's own error.
	if (!known) throw unwrapFailure(error);
	const body = {
		error: {
			code: known.code,
			message: known.message,
			...(known.reason ? { reason: known.reason } : {}),
		},
	};
	try {
		// A commit whose answer was lost may already have completed the command with its true
		// receipt: only a command that is still pending records a failure.
		await getDb()
			.update(agenticCommandRecords)
			.set({
				state: "completed",
				responseStatus: known.status,
				responseBody: JSON.stringify(body),
				completedAt: new Date(),
			})
			.where(
				and(eq(agenticCommandRecords.id, recordId), eq(agenticCommandRecords.state, "pending")),
			);
	} catch (recordingError) {
		// A call limit fails this write too: the command stays pending and the caller gets the
		// platform's own error, with its reason, instead of this answer.
		throw unwrapFailure(recordingError);
	}
	return Response.json(body, { status: known.status });
}

async function readContractJson(request: Request): Promise<unknown> {
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
		throw new ContractError("INVALID_CONTRACT", "Use Content-Type: application/json");
	const reader = request.body?.getReader();
	if (!reader) throw new ContractError("INVALID_CONTRACT", "A request body is required");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		size += result.value.byteLength;
		if (size > MAX_CONTRACT_REQUEST_BYTES) {
			await reader.cancel();
			throw new ContractError("SOURCE_PDF_TOO_LARGE", "The contract request is too large", 413);
		}
		chunks.push(result.value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function notFound(): Response {
	return errorResponse("CONTRACT_NOT_FOUND", "Contract not found", 404);
}
function errorResponse(code: string, message: string, status: number): Response {
	return Response.json({ error: { code, message } }, { status });
}

export default contractsEndpoint;
