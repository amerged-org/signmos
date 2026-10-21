import { z } from "zod";
import {
	authorizeAgentPartnerSigning,
	claimAgentCommand,
	completeAgentCommand,
	createAgentSelfSignDraft,
	fingerprintAgentBinaryCommand,
	fingerprintAgentCommand,
	getAuthorizedAgentCreatorEnvelope,
	recordAgentDocumentRead,
} from "@/db/agentic-access";
import type { AgenticPrincipal } from "@/db/agentic-access/bearer-principal";
import {
	type AgentDocumentErrorCode,
	AgentDocumentErrorSchema,
	AgentSelfSignCreateRequestSchema,
	AgentSelfSignCreateResponseSchema,
	AgentSourcePdfResponseSchema,
	agentSelfSignOperations,
} from "@/db/agentic-access/schema";
import {
	getLatestSourcePdfDocument,
	recordSourcePdfUploadRejection,
	type SourceDocument,
	SourcePdfUploadError,
	uploadSourcePdfDocument,
} from "@/db/envelope";
import { MAX_SOURCE_PDF_BYTES, PdfPolicyError } from "@/db/envelope/pdf-policy";
import { createAgentHono } from "@/hono/factory";
import { agentPartnerAuthorizationError } from "./agent-partner-errors";
import { getRequestIp, isPdf, parseSourceFilename, sha256Hex } from "./envelope-route-helpers";

const agentSelfSignSourceEndpoint = createAgentHono();
const DocumentIdSchema = z.string().uuid();
const maxSourcePdfBytes = MAX_SOURCE_PDF_BYTES;

agentSelfSignSourceEndpoint.post(agentSelfSignOperations.create.relativePath, async (c) => {
	const parsed = AgentSelfSignCreateRequestSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json(
			agentError({
				code: "AGENT_INVALID_SELF_SIGN_CREATE",
				message: "A signer name is required to create a self-sign draft",
				retryable: false,
				allowedActions: ["create_self_sign_document"],
				recoveryUrl: "/agent.md",
				fields: ["name"],
			}),
			400,
		);
	}
	const principal = c.get("agenticPrincipal");
	const claim = await claimAgentCommand({
		principal,
		idempotencyKey: requiredIdempotencyKey(c),
		operation: agentSelfSignOperations.create.operationId,
		requestFingerprint: await fingerprintAgentCommand(parsed.data),
	});
	if (claim.state !== "execute") return commandClaimResponse(claim);
	const draft = await createAgentSelfSignDraft({
		principal,
		name: parsed.data.name,
		signingMode: parsed.data.signingMode,
		requestIp: requestIp(c),
	});
	const body = AgentSelfSignCreateResponseSchema.parse({ data: draft });
	await completeAgentCommand({
		recordId: claim.recordId,
		status: 201,
		body,
		documentId: draft.documentId,
		now: requestNow(c),
	});
	return c.json(body, 201);
});

agentSelfSignSourceEndpoint.put(agentSelfSignOperations.sourceUpload.relativePath, async (c) => {
	const documentId = parsedDocumentId(c.req.param("documentId"));
	if (!documentId) return c.json(documentNotFoundError(), 404);
	const principal = c.get("agenticPrincipal");
	const contentType = c.req.header("content-type")?.split(";")[0]?.trim() ?? "";
	const filename = parseSourceFilename(c.req.header("x-source-filename"));
	const bytes = new Uint8Array(await c.req.arrayBuffer());
	const claim = await claimAgentCommand({
		principal,
		idempotencyKey: requiredIdempotencyKey(c),
		operation: agentSelfSignOperations.sourceUpload.operationId,
		requestFingerprint: await fingerprintAgentBinaryCommand({ bytes, contentType, filename }),
	});
	if (claim.state !== "execute") return commandClaimResponse(claim);
	const envelope = await getAuthorizedAgentCreatorEnvelope(principal, documentId);
	if (!envelope) {
		const body = documentNotFoundError();
		await completeAgentCommand({ recordId: claim.recordId, status: 404, body, documentId });
		return c.json(body, 404);
	}
	if (contentType !== "application/pdf" || !isPdf(bytes)) {
		await recordSourcePdfUploadRejection({
			envelopeId: documentId,
			eventType: "source_pdf.upload_rejected",
			message: principal.email,
		});
		const body = agentError({
			code: "INVALID_SOURCE_PDF",
			message: "Source document must be a PDF",
			retryable: false,
			allowedActions: ["upload_source_pdf"],
			recoveryUrl: `/api/v1/documents/${documentId}/source-pdf`,
			validValues: ["application/pdf"],
			fields: ["body"],
		});
		await completeAgentCommand({ recordId: claim.recordId, status: 400, body, documentId });
		return c.json(body, 400);
	}
	if (bytes.byteLength > maxSourcePdfBytes) {
		await recordSourcePdfUploadRejection({
			envelopeId: documentId,
			eventType: "source_pdf.upload_too_large",
			message: principal.email,
		});
		const body = agentError({
			code: "SOURCE_PDF_TOO_LARGE",
			message: "Source PDF must be at most 2 MiB",
			retryable: false,
			allowedActions: ["upload_source_pdf"],
			recoveryUrl: `/api/v1/documents/${documentId}/source-pdf`,
			fields: ["body"],
			limitBytes: maxSourcePdfBytes,
		});
		await completeAgentCommand({ recordId: claim.recordId, status: 413, body, documentId });
		return c.json(body, 413);
	}
	const bucket = (c.env as Env & { DOCUMENTS_BUCKET: R2Bucket }).DOCUMENTS_BUCKET;
	try {
		const result = await uploadSourcePdfDocument({
			envelopeId: documentId,
			uploadedBy: principal.email,
			bytes,
			sha256: await sha256Hex(bytes),
			contentType: "application/pdf",
			originalFilename: filename,
			documentsBucket: bucket,
		});
		const body = AgentSourcePdfResponseSchema.parse({
			data: agentSourcePdfResponse(result.document),
		});
		await recordAgentDocumentRead({
			principal,
			documentId,
			eventType: result.revision ? "agentic.source_pdf.revised" : "agentic.source_pdf.uploaded",
			requestIp: requestIp(c),
		});
		await completeAgentCommand({
			recordId: claim.recordId,
			status: 201,
			body,
			documentId,
			now: requestNow(c),
		});
		return c.json(body, 201);
	} catch (error) {
		if (error instanceof PdfPolicyError) {
			const body = agentError({
				code: error.code,
				message: error.message,
				retryable: false,
				allowedActions: ["upload_source_pdf"],
				recoveryUrl: `/api/v1/documents/${documentId}/source-pdf`,
			});
			await completeAgentCommand({
				recordId: claim.recordId,
				status: error.status,
				body,
				documentId,
			});
			return c.json(body, error.status);
		}
		if (!(error instanceof SourcePdfUploadError)) throw error;
		const body = agentError({
			code: error.code,
			message: error.message,
			retryable: false,
			allowedActions: envelope.status === "draft" ? ["get_source_pdf"] : [],
			recoveryUrl: `/api/v1/documents/${documentId}/source-pdf`,
		});
		await completeAgentCommand({ recordId: claim.recordId, status: 409, body, documentId });
		return c.json(body, 409);
	}
});

agentSelfSignSourceEndpoint.get(agentSelfSignOperations.sourceMetadata.relativePath, async (c) => {
	const documentId = parsedDocumentId(c.req.param("documentId"));
	if (!documentId) return c.json(documentNotFoundError(), 404);
	const principal = c.get("agenticPrincipal");
	const accessError = await requireAgentSourceRead(principal, documentId);
	if (accessError) return accessError;
	const document = await getLatestSourcePdfDocument(documentId);
	if (!document) return c.json(sourcePdfUnavailableError(documentId), 404);
	await recordAgentDocumentRead({
		principal,
		documentId,
		eventType: "agentic.source_pdf.metadata_read",
		requestIp: requestIp(c),
	});
	return c.json(AgentSourcePdfResponseSchema.parse({ data: agentSourcePdfResponse(document) }));
});

agentSelfSignSourceEndpoint.get(agentSelfSignOperations.sourceContent.relativePath, async (c) => {
	const documentId = parsedDocumentId(c.req.param("documentId"));
	if (!documentId) return c.json(documentNotFoundError(), 404);
	const principal = c.get("agenticPrincipal");
	const accessError = await requireAgentSourceRead(principal, documentId);
	if (accessError) return accessError;
	const document = await getLatestSourcePdfDocument(documentId);
	if (!document) return c.json(sourcePdfUnavailableError(documentId), 404);
	const bucket = (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
	const object = await bucket?.get(document.r2Key);
	if (!object) return c.json(sourcePdfUnavailableError(documentId), 503);
	await recordAgentDocumentRead({
		principal,
		documentId,
		eventType: "agentic.source_pdf.downloaded",
		requestIp: requestIp(c),
	});
	return new Response(await object.arrayBuffer(), {
		headers: { "cache-control": "no-store", "content-type": "application/pdf" },
	});
});

async function requireAgentSourceRead(
	principal: AgenticPrincipal,
	documentId: string,
): Promise<Response | null> {
	if (await getAuthorizedAgentCreatorEnvelope(principal, documentId)) return null;
	const authorization = await authorizeAgentPartnerSigning(principal, documentId);
	if (authorization.state === "active") return null;
	const error = agentPartnerAuthorizationError(authorization, documentId);
	return Response.json(error.body, { status: error.status });
}

function parsedDocumentId(value: string | undefined): string | null {
	const parsed = DocumentIdSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function requestNow(c: { req: { header: (name: string) => string | undefined } }): Date {
	return new Date(c.req.header("x-now") ?? Date.now());
}

function requestIp(c: {
	req: { header: (name: string) => string | undefined };
}): string | undefined {
	return getRequestIp(c.req.header("cf-connecting-ip"), c.req.header("x-forwarded-for"));
}

function requiredIdempotencyKey(c: {
	req: { header: (name: string) => string | undefined };
}): string {
	const value = c.req.header("idempotency-key")?.trim();
	if (!value) throw new Error("Idempotency middleware invariant failed");
	return value;
}

function commandClaimResponse(claim: {
	state: "execute" | "replay" | "conflict" | "in_progress";
	status?: number;
	body?: unknown;
}): Response {
	if (claim.state === "execute") throw new Error("Command claim must execute");
	if (claim.state === "replay" && typeof claim.status === "number") {
		return Response.json(claim.body, { status: claim.status });
	}
	return Response.json(
		agentError({
			code: claim.state === "conflict" ? "IDEMPOTENCY_CONFLICT" : "IDEMPOTENCY_REQUEST_IN_PROGRESS",
			message:
				claim.state === "conflict"
					? "This Idempotency-Key was already used for a different request"
					: "The original command is still in progress",
			retryable: claim.state === "in_progress",
			allowedActions: [],
			recoveryUrl: "/agent.md",
		}),
		{ status: 409 },
	);
}

function documentNotFoundError() {
	return agentError({
		code: "AGENT_DOCUMENT_NOT_FOUND",
		message: "Document not found",
		retryable: false,
		allowedActions: ["list_documents"],
		recoveryUrl: "/api/v1/documents",
	});
}

function sourcePdfUnavailableError(documentId: string) {
	return agentError({
		code: "AGENT_SOURCE_PDF_UNAVAILABLE",
		message: "The source PDF is not available",
		retryable: false,
		allowedActions: ["upload_source_pdf"],
		recoveryUrl: `/api/v1/documents/${documentId}/source-pdf`,
	});
}

function agentSourcePdfResponse(document: SourceDocument) {
	return {
		documentId: document.envelopeId,
		version: document.version,
		sha256: document.sha256,
		byteSize: document.byteSize,
		contentType: document.contentType,
		originalFilename: document.originalFilename,
		uploadedAt: document.uploadedAt.toISOString(),
		downloadUrl: `/api/v1/documents/${document.envelopeId}/source-pdf/content`,
	};
}

function agentError(error: {
	code: AgentDocumentErrorCode;
	message: string;
	retryable: boolean;
	allowedActions: string[];
	recoveryUrl: string | null;
	validValues?: string[];
	fields?: string[];
	limitBytes?: number;
}) {
	return AgentDocumentErrorSchema.parse({ error });
}

export default agentSelfSignSourceEndpoint;
