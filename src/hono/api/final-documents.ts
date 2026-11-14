import { getCookie } from "hono/cookie";
import {
	getCompletedDocumentView,
	getFinalDocumentDownloadContext,
	regenerateFinalDocumentArtifact,
} from "@/db/envelope";
import { isCurrentFinalPdfArtifact } from "@/db/envelope/final-pdf-renderer";
import { hashSignerSession, signerEmailCookie } from "@/db/signer-email";
import { createHono } from "@/hono/factory";
import { requireSignerBrowserToken } from "./signer-email-auth";

const finalDocumentsEndpoint = createHono();
finalDocumentsEndpoint.use("/*", async (c, next) => {
	await next();
	c.res.headers.set("Cache-Control", "no-store");
	c.res.headers.set("Referrer-Policy", "no-referrer");
});
finalDocumentsEndpoint.get("/:token/pdf", async (c) => {
	const rawSession = getCookie(c, signerEmailCookie);
	const access = {
		now: parseNow(c.req.header("x-now")),
		emailSessionHash: rawSession ? await hashSignerSession(rawSession) : "",
	};
	const context = await getFinalDocumentDownloadContext(c.req.param("token"), access);
	if (!context) {
		const authorization = await requireSignerBrowserToken(c);
		if (authorization instanceof Response) return authorization;
		return c.json(
			{
				error: {
					code: "FINAL_PDF_NOT_FOUND",
					message: "Completed PDF is not available",
				},
			},
			404,
		);
	}

	const document = context.document;
	const bucket = (c.env as (Env & { DOCUMENTS_BUCKET?: R2Bucket }) | undefined)?.DOCUMENTS_BUCKET;
	const object = await bucket?.get(document.r2Key);
	if (!bucket || !object) {
		return c.json(
			{
				error: {
					code: "FINAL_PDF_NOT_FOUND",
					message: "Completed PDF is not available",
				},
			},
			404,
		);
	}

	const bytes = new Uint8Array(await object.arrayBuffer());
	const isCurrent = await isCurrentFinalPdfArtifact(bytes);
	let repaired: Awaited<ReturnType<typeof regenerateFinalDocumentArtifact>> = null;
	if (!isCurrent && context.snapshot.sourceDocument) {
		try {
			repaired = await regenerateFinalDocumentArtifact(document, {
				documentsBucket: bucket,
				snapshot: context.snapshot,
				access: context.access,
			});
		} catch {
			return c.json(
				{
					error: {
						code: "FINAL_PDF_REPAIR_PENDING",
						message: "The retained PDF is being checked. Retry this download.",
						retryable: true,
					},
				},
				503,
			);
		}
	}
	if (!repaired && !(await getFinalDocumentDownloadContext(c.req.param("token"), access))) {
		return c.json(
			{ error: { code: "FINAL_PDF_NOT_FOUND", message: "Completed PDF is not available" } },
			404,
		);
	}

	const responseBytes = repaired?.bytes ?? bytes;
	return new Response(toArrayBuffer(responseBytes), {
		headers: { "content-type": repaired?.document.contentType ?? document.contentType },
	});
});

finalDocumentsEndpoint.get("/:token", async (c) => {
	const authorization = await requireSignerBrowserToken(c);
	if (authorization instanceof Response) return authorization;
	const view = await getCompletedDocumentView(c.req.param("token"), {
		now: parseNow(c.req.header("x-now")),
	});
	if (!view) {
		return c.json(
			{
				error: {
					code: "FINAL_PDF_NOT_FOUND",
					message: "Completed PDF is not available",
				},
			},
			404,
		);
	}

	return c.json({ data: view });
});

export default finalDocumentsEndpoint;

function parseNow(nowHeader: string | undefined): Date {
	return new Date(nowHeader ?? Date.now());
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
