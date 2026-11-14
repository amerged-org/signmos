import { z } from "zod";
import { VerifySignerEmailCodeSchema } from "@/db/signer-email/schema";
import {
	DraftContractJsonSchema,
	PatchContractSchema,
	SendContractSchema,
} from "@/omh/contracts-draft-schema";
import { MultipartContractSchema } from "@/omh/contracts-multipart";
import { CreateContractSchema } from "@/omh/contracts-schema";

const security = [{ bearerAuth: [] }];
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const token = { name: "token", in: "path", required: true, schema: { type: "string" } };
const idempotencyKey = {
	name: "Idempotency-Key",
	in: "header",
	required: true,
	schema: { type: "string", minLength: 1, maxLength: 200 },
};
const summary = {
	type: "object",
	required: ["id", "title", "status", "recipients", "createdAt", "completedAt", "downloadUrl"],
	properties: {
		id: { type: "string", format: "uuid" },
		title: { type: "string" },
		status: { type: "string" },
		recipients: {
			type: "array",
			items: {
				type: "object",
				required: ["name", "email", "status"],
				properties: {
					name: { type: "string" },
					email: { type: "string", format: "email" },
					status: { type: "string" },
				},
			},
		},
		createdAt: { type: "string", format: "date-time" },
		completedAt: { type: ["string", "null"], format: "date-time" },
		downloadUrl: { type: ["string", "null"] },
	},
};
const data = (schema: unknown) => ({
	type: "object",
	required: ["data"],
	properties: { data: schema },
});
const response = (description: string, schema: unknown) => ({
	description,
	content: { "application/json": { schema } },
});
const errorSchema = {
	type: "object",
	required: ["error"],
	properties: {
		error: {
			type: "object",
			required: ["code", "message"],
			properties: {
				code: { type: "string" },
				message: { type: "string" },
				emailHint: { type: "string" },
				verificationUrl: { type: "string" },
				retryAfterSeconds: { type: "integer" },
				retryAt: { type: "string", format: "date-time" },
				retryable: { type: "boolean" },
			},
		},
	},
};
const errors = Object.fromEntries(
	Object.entries({
		400: "Invalid contract or missing Idempotency-Key; HTML rendering is unavailable",
		403: "Administrator authentication or browser CSRF check failed",
		404: "CONTRACT_NOT_FOUND: unknown, deleted or owned by another identity",
		409: "Lifecycle, concurrent change or idempotency conflict; reload before a deliberate retry",
		413: "PDF size, page or field limit exceeded",
		502: "Email delivery could not be confirmed",
		503: "Private storage, email or source/final PDF is unavailable; STORAGE_DELETE_PENDING waits for signed uploads to expire",
	}).map(([code, description]) => [
		code,
		{
			...response(description, errorSchema),
			...(code === "503"
				? {
						headers: {
							"Retry-After": {
								schema: { type: "string" },
								description:
									"Absolute HTTP date when pending private erasure can be retried with a new Idempotency-Key; preserved on exact replay",
							},
						},
					}
				: {}),
		},
	]),
);

export function buildContractsPaths() {
	const json = z.toJSONSchema(CreateContractSchema, { io: "input" });
	const placeholder = z.toJSONSchema(MultipartContractSchema, { io: "input" });
	const placeholderJson = {
		...placeholder,
		required: [...(placeholder.required ?? []), "pdf"],
		properties: { ...placeholder.properties, pdf: z.toJSONSchema(CreateContractSchema.shape.pdf) },
	};
	const multipart = {
		schema: {
			type: "object",
			required: ["pdf", "definition"],
			additionalProperties: false,
			properties: { pdf: { type: "string", format: "binary" }, definition: placeholder },
		},
		encoding: {
			pdf: { contentType: "application/pdf" },
			definition: { contentType: "application/json" },
		},
	};
	const draftContent = {
		"application/json": { schema: z.toJSONSchema(DraftContractJsonSchema, { io: "input" }) },
		"multipart/form-data": multipart,
	};
	const metadataPdf = {
		type: "object",
		required: ["filename"],
		properties: { filename: { type: "string" } },
	};
	const detail = {
		...summary,
		properties: {
			...summary.properties,
			definition: {
				oneOf: [
					{ ...json, properties: { ...json.properties, pdf: metadataPdf } },
					{
						...placeholderJson,
						properties: {
							...placeholderJson.properties,
							kind: { const: "placeholder" },
							pdf: metadataPdf,
						},
					},
					{ type: "null" },
				],
			},
		},
	};
	const sendResult = {
		...summary,
		required: [...summary.required, "signingLinks"],
		properties: {
			...summary.properties,
			signingLinks: {
				type: "array",
				items: {
					type: "object",
					required: ["recipientId", "email", "url", "expiresAt"],
					properties: {
						recipientId: { type: "string", format: "uuid" },
						email: { type: "string", format: "email" },
						url: { type: "string", format: "uri" },
						expiresAt: { type: "string", format: "date-time" },
					},
				},
			},
		},
	};
	return {
		"/api/contracts": {
			get: {
				operationId: "listContracts",
				summary: "List the latest 100 owned contracts",
				security,
				responses: {
					"200": response(
						"Owned contracts without personal links",
						data({ type: "array", items: summary }),
					),
					...errors,
				},
			},
			post: {
				...mutation("createContract", "Create and send a contract (existing endpoint)", [], {
					"201": response("Created and sent (legacy JSON)", data(summary)),
					"202": response("Accepted and queued (multipart)", data(summary)),
				}),
				description:
					"Existing behavior retained. Links delivered by email, never returned here. PDF + JSON only; HTML rendering remains OPEN.",
				requestBody: {
					required: true,
					content: { "application/json": { schema: json }, "multipart/form-data": multipart },
				},
			},
		},
		"/api/contracts/drafts": {
			post: {
				...mutation("createContractDraft", "Create an unsigned PDF + JSON draft", [], {
					"201": response(
						"Owned draft; no invitations or signing credentials created",
						data(summary),
					),
				}),
				description:
					"The creator signs only when explicitly included as a party. HTML upload and HTML-to-PDF remain OPEN and are explicitly rejected.",
				requestBody: { required: true, content: draftContent },
			},
		},
		"/api/contracts/{id}": {
			get: {
				operationId: "getContract",
				summary: "Get owned contract, saved definition and recipient progress",
				security,
				parameters: [id],
				responses: {
					"200": response("Contract metadata; no PDF base64 or personal links", data(detail)),
					...errors,
				},
			},
			patch: {
				...mutation(
					"updateContractDraft",
					"Update title, parties or fields of an active draft",
					[id],
					{ "200": response("Updated draft", data(summary)) },
				),
				description:
					"Supplied arrays replace their previous definitions; omitted properties are kept. Sent documents are immutable. The updated definition must match the PDF.",
				requestBody: jsonBody(PatchContractSchema),
			},
			delete: mutation(
				"deleteContractDraft",
				"Delete an active draft and every private PDF version",
				[id],
				{ "200": response("Draft deleted", data(lifecycleResult("deleted"))) },
			),
		},
		"/api/contracts/{id}/pdf": {
			put: {
				...mutation(
					"replaceContractDraftPdf",
					"Replace a draft PDF and its complete definition",
					[id],
					{ "200": response("Updated draft with replacement PDF", data(summary)) },
				),
				requestBody: { required: true, content: draftContent },
			},
			get: {
				operationId: "downloadContractPdf",
				summary: "Download the owned completed PDF",
				security,
				parameters: [id],
				responses: { "200": pdfResponse(), ...errors },
			},
		},
		"/api/contracts/{id}/send": {
			post: {
				...mutation(
					"sendContractDraft",
					"Freeze a draft and return personal links to its owner",
					[id],
					{
						"200": response("Manual delivery: sent, no invitation emails", data(sendResult)),
						"202": response(
							"Email delivery: queued, links inactive until every invitation is accepted",
							data(sendResult),
						),
					},
				),
				description:
					"delivery is mandatory. Manual delivery skips invitation emails; every personal link still requires a six-digit email code. Exact idempotent retries replay the original links. List and detail never reveal links.",
				requestBody: jsonBody(SendContractSchema),
			},
		},
		"/api/contracts/{id}/cancel": {
			post: {
				...mutation(
					"cancelContract",
					"Cancel an outstanding contract and revoke personal links",
					[id],
					{
						"200": response(
							"Contract cancelled; retained record",
							data(lifecycleResult("expired")),
						),
					},
				),
				requestBody: { ...jsonBody(z.object({}).strict()), required: false },
			},
		},
		"/api/contracts/{id}/retry-invitations": {
			post: mutation(
				"retryContractInvitations",
				"Requeue invitations after an uncertain delivery",
				[id],
				{
					"200": response(
						"Retry result",
						data({
							type: "object",
							required: ["requeued", "manualReview"],
							properties: { requeued: { type: "integer" }, manualReview: { type: "integer" } },
						}),
					),
				},
			),
		},
		...signerEmailPaths(),
	};
}

function mutation(
	operationId: string,
	title: string,
	parameters: unknown[],
	responses: Record<string, unknown>,
) {
	return {
		operationId,
		summary: title,
		security,
		parameters: [...parameters, idempotencyKey],
		responses: { ...responses, ...errors },
	};
}
function jsonBody(schema: z.ZodType) {
	return {
		required: true,
		content: { "application/json": { schema: z.toJSONSchema(schema, { io: "input" }) } },
	};
}
function lifecycleResult(status: "deleted" | "expired") {
	return {
		type: "object",
		required: ["id", "status"],
		properties: { id: { type: "string", format: "uuid" }, status: { const: status } },
	};
}
function pdfResponse() {
	return {
		description: "Completed PDF bytes",
		content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
	};
}
function signerEmailPaths() {
	const signerErrors = {
		"400": response(
			"INVALID_EMAIL_CODE: invalid, expired, consumed or exhausted code",
			errorSchema,
		),
		"403": response("Same-origin check failed or PARTNER_VERIFICATION_REQUIRED", errorSchema),
		"404": response("TOKEN_NOT_FOUND; raw final-document UUIDs are not credentials", errorSchema),
		"410": response("EXPIRED_TOKEN: link is no longer active", errorSchema),
		"429": {
			...response("EMAIL_CODE_RATE_LIMITED", errorSchema),
			headers: {
				"Retry-After": { schema: { type: "integer" }, description: "Seconds before retry" },
			},
		},
		"503": response("EMAIL_DELIVERY_UNAVAILABLE or EMAIL_VERIFICATION_UNAVAILABLE", errorSchema),
	};
	const operation = { security: [], parameters: [token] };
	return {
		"/api/signing/verifications/{token}": {
			get: {
				...operation,
				operationId: "inspectPersonalSigningLink",
				summary: "Inspect a link without verifying identity or sending email",
				responses: {
					"200": response(
						"Email proof required, including for existing open links",
						data({
							type: "object",
							required: ["status", "emailHint", "signingLink"],
							properties: {
								status: { const: "email_verification_required" },
								emailHint: { type: "string" },
								signingLink: {
									type: "object",
									required: ["token", "url"],
									properties: { token: { type: "string" }, url: { type: "string" } },
								},
							},
						}),
					),
					...signerErrors,
				},
			},
		},
		"/api/signing/{token}/email-code/request": {
			post: {
				...operation,
				operationId: "requestSignerEmailCode",
				summary: "Email a six-digit code to the assigned party",
				description:
					"No code is returned. Ten-minute expiry, five failed attempts, single redemption; recipient cooldown 60 seconds, recipient limit five/hour, IP limit 20/hour. No account required. Same-origin browser request.",
				requestBody: { ...jsonBody(z.object({}).strict()), required: false },
				responses: {
					"200": response(
						"Code requested",
						data({
							type: "object",
							required: ["emailHint", "expiresInSeconds", "retryAfterSeconds"],
							properties: {
								emailHint: { type: "string" },
								expiresInSeconds: { const: 600 },
								retryAfterSeconds: { const: 60 },
							},
						}),
					),
					...signerErrors,
				},
			},
		},
		"/api/signing/{token}/email-code/verify": {
			post: {
				...operation,
				operationId: "verifySignerEmailCode",
				summary: "Redeem one email code for a recipient-bound browser session",
				description:
					"Cookie bound to this token, envelope, recipient and email. Fixed eight-hour lifetime clipped to token expiry. Required on personal document reads, mutations and PDF downloads, including final links. Prior token verifiedAt is insufficient.",
				requestBody: jsonBody(VerifySignerEmailCodeSchema),
				responses: {
					"200": {
						...response(
							"Email verified",
							data({
								type: "object",
								required: ["verified", "signingUrl"],
								properties: { verified: { const: true }, signingUrl: { type: "string" } },
							}),
						),
						headers: {
							"Set-Cookie": {
								schema: { type: "string" },
								description:
									"signmos_signer_session; HttpOnly; Path=/api/; SameSite=Strict; Secure in hosted environments",
							},
						},
					},
					...signerErrors,
				},
			},
		},
	};
}
