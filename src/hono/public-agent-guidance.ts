import {
	MAX_DOCUMENT_FIELDS,
	MAX_SOURCE_PDF_BYTES,
	MAX_SOURCE_PDF_PAGES,
} from "@/db/envelope/pdf-policy-limits";
import { agentCreatorControlGuidance } from "./public-agent-creator-control-contract";
import { agentPartnerGuidance } from "./public-agent-partner-contract";
import { agentRateLimitGuidance } from "./public-agent-rate-limit-contract";

export function buildAgentGuidance(): string {
	return `# Signmos Agent API

Read this guide and [/openapi.json](/openapi.json) before acting. Signmos Agentic tokens represent one verified email. Use only documented operations and stay within the user goal.

## Secret handling

Prefer providing the token through the SIGNMOS_TOKEN environment variable. The authenticated Agentic console automatically selects a newly generated token for its private agent prompt. Because Signmos cannot recover an existing raw token, you may instead paste a full token from your saved copy into the browser-only prompt control. Never place it in URLs, issue bodies, source control, or logs. Send it only in the Authorization: Bearer $SIGNMOS_TOKEN header. Anyone holding the token can send and can request sign, decline, cancel, expire, or delete actions as the verified email; those protected actions require a matching human's approval before execution.

## Confirm identity

Call GET /api/v1/me first and confirm the normalized verified email before reading documents.

## Discover documents

Call GET /api/v1/documents. Search and combine role, group, status, and page filters. Catalog order puts documents needing action first. Begin from this catalog; never probe guessed IDs.

## Creator, signer, and dual roles

Each response reports creator, signer, or creator_and_signer plus server-derived allowedActions. Treat these as current lifecycle facts and invoke only operations permitted for the verified role.

## Poll document status

Use GET /api/v1/documents/{documentId}/status and follow machine fields such as retryable, allowedActions, and recoveryUrl. Do not infer state from prose or poll undocumented routes.

## Wait for human review

Sign/complete, decline, cancel, expire, and delete return HTTP 202 with pending_human_review, commandId, reviewUrl, statusUrl, expiresAt, and notificationStatus. They have no protected document side effect while pending. Tell the user that approval is required; do not claim success or attempt to bypass, automate, or impersonate the reviewer. Poll only the returned statusUrl with the exact personal token that created the command. An exact Idempotency-Key replay returns the same command and sends no duplicate notice.

The server derives the reviewer from the authorized signer or creator role. The reviewer opens the current PDF and exact proposed payload in Signmos, then chooses Approve and execute, Reject request, or Not now. Review expires exactly 24 hours after creation and is invalidated if the source PDF, payload binding, personal token, or reviewer role changes. Handle HUMAN_REVIEW_REJECTED, HUMAN_REVIEW_EXPIRED, HUMAN_REVIEW_INVALIDATED, HUMAN_REVIEW_FORBIDDEN, HUMAN_REVIEW_ALREADY_DECIDED, and HUMAN_REVIEW_EXECUTION_FAILED as terminal or recovery states. notificationStatus failed leaves the command pending and available in My Documents; it never grants authority.

Use Signmos only for authorized, lawful document workflows. Do not use agent actions for fraud, impersonation, deception, rights violations, prohibited high-stakes automated decisions, or to evade product safeguards.

## Inspect detail and history

Use the document detail and history routes for authorized lifecycle, retention, parties, and public events. Responses never contain browser cookies, process links, internal headers, or security-audit rows.

## Download a completed PDF

When download_final_pdf is allowed, request GET /api/v1/documents/{documentId}/pdf and accept application/pdf. A not-ready response may be polled through its recovery URL.

## Revoked, deleted, or unavailable

A revoked token returns 401 and must be replaced through fresh email verification. Deleted or unauthorized documents return the same 404 without revealing existence. An unavailable final object returns a retryable 503 with a safe recovery URL.

## Create a self-sign draft

POST /api/v1/documents with your signer name. The verified Bearer email owns the draft; no additional verification or emailed credential is used.

## Upload one source PDF

PUT /api/v1/documents/{documentId}/source-pdf with application/pdf bytes at most ${MAX_SOURCE_PDF_BYTES} bytes (2 MiB), ${MAX_SOURCE_PDF_PAGES} pages, and ${MAX_DOCUMENT_FIELDS} signing fields per document. Inspect metadata or download the authorized preparation copy from the documented source routes. SOURCE_PDF_TOO_LARGE, SOURCE_PDF_TOO_MANY_PAGES, and SOURCE_PDF_TOO_MANY_FIELDS require a smaller PDF or fewer fields.

## Save a signature profile

POST a typed or drawn profile with rememberSignature true. Reusable signature content is stored only with this explicit consent.

## Place signature and date fields

Use explicit coordinates or the default-fields command. Page numbers must be between 1 and ${MAX_SOURCE_PDF_PAGES}; the document may have at most ${MAX_DOCUMENT_FIELDS} signing fields. One signature placeholder is permitted for the self-signer, and preparation commands are draft-only.

## Review and reposition

GET the signing task and PATCH only assigned fields where the self-sign workflow permits. Follow returned source URLs and field identifiers; never use or request a process token.

## Complete self-signing

POST a typed or drawn signature to the completion command. The server controls the signing date. Wait for matching-human approval and poll the returned command status; only a completed terminal result permits you to continue to detail, history, or final PDF.

## Create a two-party draft

POST /api/v1/documents with signingMode me_and_another_signer. The normalized Bearer email is the creator and receives no extra verification credential.

## Manage draft recipients

List, add, update, or delete partner recipients while draft. Use normalized valid emails, keep the total between 1 and 10, and follow duplicate, limit, and recovery errors.

## Prepare both parties

Place explicit fields with recipientId or default fields with recipientIds for the creator and every partner. Each recipient needs its own valid signature/date assignments.

## Complete creator signing

Use the same completion command with a typed or drawn creator signature before delivery. The server fixes the signing date. Wait for the creator's human approval and a completed command result before sending.

## Send the partner invitation

POST the send command only after source, partner recipients, all fields, and creator signing are ready. Signmos delivers only eligible partner invitations and never returns invitation or process credentials.

## Resend an eligible invitation

POST the recipient resend command only when server-derived actions permit it. A successful resend creates one fresh partner invitation without duplicating recipients.

## Poll partner progress

Poll document status and history for recipient states and allowedActions. Do not infer delivery or signing progress from a prior response.

## Delivery-provider failure

EMAIL_DELIVERY_FAILED is retryable and leaves the document unsent. Retry the exact request with the same Idempotency-Key to recover the original result; use a fresh key only for a new intended attempt.

## Final PDF generation failure

FINAL_PDF_GENERATION_FAILED means the recorded signature is durable but the document is still sent while its final PDF is unavailable. Do not report completion. Retry the same recorded signature to resume final PDF creation; never replace it or request decline or changes after signing. If a prior human-review command has failed, create a new review with a fresh Idempotency-Key for this same signature and obtain approval again.
${agentPartnerGuidance}
${agentCreatorControlGuidance}
${agentRateLimitGuidance}

## Use a fresh Idempotency-Key

Every POST, PUT, PATCH, or DELETE command requires a fresh Idempotency-Key for one intended mutation. Exact retries return the original status and body. Reusing a key for a changed operation, JSON body, or PDF returns IDEMPOTENCY_CONFLICT without executing the changed intent.
`;
}
