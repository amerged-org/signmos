# amerged Sign contracts API

The private console and API run at `https://sign.amerged.com`. Only email addresses listed in the deployment's `SIGN_ADMIN_EMAILS` or `SIGN_EXTRA_ADMIN_EMAILS` setting can administer contracts. Personal recipient links require a six-digit email code and a recipient-bound browser session; recipients do not need an administrator login or an account. The machine-readable contract is available at `/openapi.json`.

## Authentication

For integrations, sign in to the private amerged Sign console and create a token in the API section and send it as `Authorization: Bearer <token>`. Keep the secret on your server. The request sender always comes from the authenticated email; payloads cannot supply another sender.

The browser console uses an HttpOnly session cookie. Browser mutations additionally require the same origin and the `X-CSRF-Token` obtained from the session endpoint. Creating or revoking API tokens requires the verified administrator session and its CSRF token.

Every contract mutation requires an `Idempotency-Key` of 1–200 characters. Reuse the same key with identical method, target and content when retrying an uncertain response. An exact retry replays the original status and body, including the original send links; changed content returns `409 IDEMPOTENCY_CONFLICT`. A pending command returns `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`. Keys are scoped to the personal token, or to the owner identity for browser requests. Use a different key for each deliberate change.

A lost response does not mean draft creation or PDF replacement failed. Retry the same request with the same key first: if the change committed, the saved success receipt is replayed without repeating the upload or creating another draft.

## API-first draft lifecycle

Create a PDF + JSON draft, inspect it, make changes, and send only after preparation is complete. There is no stored-template management. A draft does not send invitations or create a signature. The authenticated owner is the creator and signs only when explicitly included in the party definitions. Including that email creates an unsigned party with its own fields and personal link; it never creates consent or a signature automatically.

| Endpoint | Input and result |
| --- | --- |
| `POST /api/contracts/drafts` | PDF + JSON definition as multipart, or the JSON formats described below. Returns `201` with a `draft`. |
| `GET /api/contracts` | Latest 100 owned contracts, newest first. |
| `GET /api/contracts/{id}` | Summary, recipient progress and saved `definition` metadata. PDF metadata contains `filename`, never base64 or raw signing links. |
| `PATCH /api/contracts/{id}` | JSON with one or more of `title`, `recipients` and `fields`. Arrays replace their previous definitions; omitted properties are kept. Returns `200`. |
| `PUT /api/contracts/{id}/pdf` | Complete replacement PDF + JSON definition, using the same formats as draft creation. Returns `200`. |
| `DELETE /api/contracts/{id}` | Deletes a draft and all private PDF versions. Returns `200` with `{ "data": { "id": "…", "status": "deleted" } }`. |
| `POST /api/contracts/{id}/send` | JSON `{ "delivery": "email" }` or `{ "delivery": "manual" }`. Returns the summary plus personal `signingLinks`. |
| `POST /api/contracts/{id}/cancel` | JSON `{}`. Cancels an outstanding contract and revokes personal links. Returns `200` with `{ "data": { "id": "…", "status": "expired" } }`. |
| `GET /api/contracts/{id}/pdf` | Completed PDF; requires owner authentication and returns `409 FINAL_PDF_NOT_READY` until complete. |

Only an active draft can be edited, have its PDF replaced, be deleted or be sent; otherwise the API returns `409 CONTRACT_NOT_DRAFT`. After sending, the PDF, recipients and fields are immutable. Cancellation is available for `draft`, `preparing`, `queued`, `sent`, `changes_requested`, `awaiting_verification` and already `expired` contracts; completed, declined or deleted contracts cannot be cancelled (`409 CONTRACT_NOT_CANCELLABLE`). It revokes access and keeps the contract record. Concurrent changes or an in-progress PDF replacement can return `409 CONTRACT_CHANGED`; reload before a deliberate retry. Unknown, deleted and other owners' contracts all return `404 CONTRACT_NOT_FOUND`.

A draft can retain at most 4,000 distinct private artifact keys, including recorded versions from failed or uncertain uploads. At that limit, another PDF replacement returns `413 SOURCE_VERSION_LIMIT` before uploading. Delete the draft and create a new one with the desired PDF and definition.

Deleting a recently uploaded draft can return `503 STORAGE_DELETE_PENDING` while its signed upload window closes, normally up to about 5½ minutes after upload. The error includes `retryAt` and `retryable: true`; the `Retry-After` header gives the same deadline as an absolute HTTP date. Wait until that deadline, then retry `DELETE` with a **new** `Idempotency-Key`. Reusing the original key replays its original pending response and deadline. The contract remains blocked from sending or editing while deletion is pending, and is marked `deleted` only after private erasure is confirmed.

Use the placeholder definition below for multipart drafts:

```sh
curl https://sign.amerged.com/api/contracts/drafts \
  -H "Authorization: Bearer $SIGN_API_TOKEN" \
  -H "Idempotency-Key: draft-your-stable-reference" \
  -F 'pdf=@agreement.pdf;type=application/pdf' \
  -F 'definition=@definition.json;type=application/json'

curl -X PATCH https://sign.amerged.com/api/contracts/CONTRACT_ID \
  -H "Authorization: Bearer $SIGN_API_TOKEN" \
  -H "Idempotency-Key: update-your-stable-reference" \
  -H "Content-Type: application/json" \
  --data '{"title":"Updated agreement"}'

curl -X PUT https://sign.amerged.com/api/contracts/CONTRACT_ID/pdf \
  -H "Authorization: Bearer $SIGN_API_TOKEN" \
  -H "Idempotency-Key: replacement-your-stable-reference" \
  -F 'pdf=@agreement-v2.pdf;type=application/pdf' \
  -F 'definition=@definition-v2.json;type=application/json'

curl -X POST https://sign.amerged.com/api/contracts/CONTRACT_ID/send \
  -H "Authorization: Bearer $SIGN_API_TOKEN" \
  -H "Idempotency-Key: send-your-stable-reference" \
  -H "Content-Type: application/json" \
  --data '{"delivery":"manual"}'
```

Draft creation and PDF replacement also accept `application/json`: either the legacy JSON shape below or a placeholder definition with an added `pdf: { "filename": "agreement.pdf", "base64": "…" }` property. Legacy drafts use `recipient` and coordinate-based `fields` in PATCH requests; placeholder drafts use `recipients` and named placeholder `fields`. Every change must leave the PDF markers and field definitions consistent.

Both delivery modes return links only in the authenticated owner's send response:

```json
{
  "data": {
    "id": "<contract UUID>",
    "status": "sent",
    "signingLinks": [
      {
        "recipientId": "<recipient UUID>",
        "email": "ada@example.com",
        "url": "https://sign.amerged.com/signing-verifications/<personal token>",
        "expiresAt": "2026-11-21T12:00:00.000Z"
      }
    ]
  }
}
```

The actual response also includes the normal summary fields. `manual` returns `200` with status `sent` and creates no invitation emails; the owner distributes each link to its intended party. `email` returns `202` with status `queued` and stores invitations in a durable outbox. Email-mode links stay inactive until every invitation has been accepted for delivery. List and detail responses never reveal these links. Treat them as private recipient credentials, even though opening one still requires an email code.

## PDF placeholders and existing create-and-send

`POST /api/contracts` retains the existing create-and-send behavior. It accepts a PDF and a JSON definition as `multipart/form-data`, using the same placeholder definition as the draft endpoints. Use an administrator's Bearer token and an `Idempotency-Key` header.

Insert selectable text placeholders such as `{{1.name}}`, `{{1.sign}}`, and `{{2.agree}}` directly in the PDF. The number identifies the recipient by `index`; the name identifies its field definition. Repeated occurrences of the same placeholder share one answer. Define each distinct placeholder exactly once in JSON:

```json
{
  "title": "Consulting agreement",
  "recipients": [
    { "index": 1, "name": "Ada Lovelace", "email": "ada@example.com" },
    { "index": 2, "name": "Grace Hopper", "email": "grace@example.com" }
  ],
  "fields": [
    { "recipient": 1, "name": "name", "type": "text", "label": "Full name", "required": true },
    { "recipient": 1, "name": "sign", "type": "signature", "label": "Signature", "required": true },
    { "recipient": 2, "name": "agree", "type": "checkbox", "label": "I agree", "required": false }
  ]
}
```

```sh
curl https://sign.amerged.com/api/contracts \
  -H "Authorization: Bearer $SIGN_API_TOKEN" \
  -H "Idempotency-Key: contract-your-stable-reference" \
  -F 'pdf=@agreement.pdf;type=application/pdf' \
  -F 'definition=@definition.json;type=application/json'
```

Supported field types are `text`, `date`, `checkbox`, and `signature`. The field name starts with a letter or underscore and may contain letters, numbers, underscores and hyphens. Provide one to three parties with unique indices and email addresses, and at least one field per party. The existing `POST /api/contracts` endpoint requires external recipients; the draft flow permits the sender as an explicitly defined party. Recipients may complete only their own fields. Required fields must be completed; optional fields can remain empty. All recipients must complete their part before the finished PDF is available.

Multipart requests return `202` with status `queued` after the document is stored. Invitations are processed by a scheduled worker approximately every five minutes; backlog or provider problems can delay delivery further. Poll `GET /api/contracts/{id}` until it reports `sent`, or `delivery_failed` if delivery needs attention. An identical retry returns the original `202` receipt and does not enqueue another contract. A `delivery_failed` response requires investigation and the explicit retry operation described below; signing links are inactive until delivery to all recipients is confirmed.

A PDF must be unencrypted, readable and at most 2 MiB and 10 pages, with at most 20 placeholder occurrences. Placeholders must be selectable PDF text: scanned images cannot be used. Place each marker in a separate text object. A marker within surrounding text is accepted only when its exact bounds can be determined from unambiguous font metrics; rotated or cropped pages are rejected. The marker determines the available visual space. If a value does not fit legibly, the finished PDF points to the full value on a continuation page. Characters unsupported by the embedded font are rejected. The API rejects unmatched, malformed or unsupported placeholders instead of silently sending an incomplete document. Check placement in the PDF before sending. The finished PDF visually covers placeholders; this is not secure redaction of the original PDF text.

## Legacy JSON contract upload

`POST /api/contracts` accepts JSON and requires an `Idempotency-Key` header with 1–200 characters. Reuse the same key and identical JSON when retrying an uncertain request. Identical requests replay the original HTTP status and response without sending another invitation. A changed request with the same key returns `409 IDEMPOTENCY_CONFLICT`. A command still running returns `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`; retry with the original key after a delay. The key is scoped to the personal token, or to the owner identity for browser requests.

```json
{
  "title": "Consulting agreement",
  "recipient": {
    "name": "Ada Lovelace",
    "email": "ada@example.com"
  },
  "pdf": {
    "filename": "agreement.pdf",
    "base64": "<standard base64 of the PDF bytes>"
  }
}
```

Send the prepared JSON file from a server:

```sh
curl https://sign.amerged.com/api/contracts \
  -H "Authorization: Bearer $SIGN_API_TOKEN" \
  -H "Idempotency-Key: contract-your-stable-reference" \
  -H "Content-Type: application/json" \
  --data-binary @contract.json
```

The endpoint validates a readable, unencrypted PDF of at most 2 MiB with at most 10 pages, creates a draft owned by the authenticated email, uploads the document, adds the recipient and fields, and sends an invitation through the configured email provider. The recipient must differ from the sender. The sender is not added as a signer and no sender signature is fabricated.

By default, a separate signing page is appended after the original pages. Signature and date fields appear on this page, preserving the contents of the original pages. The stored source PDF includes this signing page and its checksum refers to that stored version. The resulting source PDF, including the appended page, must stay within 2 MiB and 10 pages; default placement therefore accepts at most 9 original pages. This endpoint currently supports one external signer per contract.

The optional `fields` array places fields on the original document instead of appending a page:

```json
{
  "fields": [
    { "type": "signature", "page": 2, "x": 72, "y": 620, "width": 280, "height": 70 },
    { "type": "date", "page": 2, "x": 72, "y": 710, "width": 180, "height": 35 }
  ]
}
```

Coordinates use a normalized 612 × 792 canvas for every page, measured from its top left; rendering scales these coordinates to the actual page size. Page numbers start at 1. Custom fields must fit within the canvas, reference an existing page, and include exactly one signature field. Up to 20 fields are accepted. Check placement against the original PDF before sending.

Successful creation returns `201`:

```json
{
  "data": {
    "id": "<contract UUID>",
    "title": "Consulting agreement",
    "status": "sent",
    "recipients": [
      { "name": "Ada Lovelace", "email": "ada@example.com", "status": "sent" }
    ],
    "createdAt": "2026-10-21T10:00:00.000Z",
    "completedAt": null,
    "downloadUrl": null
  }
}
```

This existing create-and-send endpoint delivers links by email and does not return raw signer credentials. Use the draft send endpoint when the authenticated owner needs personal links or manual invitation delivery.

## Read status and download

| Endpoint | Response |
| --- | --- |
| `GET /api/contracts` | `{ "data": [...] }`, up to the latest 100 contracts owned by the authenticated email, newest first. |
| `GET /api/contracts/{id}` | `{ "data": { ... } }` with current status, recipient progress, and final-download availability. |
| `GET /api/contracts/{id}/pdf` | Completed PDF with signatures and audit certificate. Returns `409 FINAL_PDF_NOT_READY` until complete. |

Use the same authentication for all reads. A valid token for another allowlisted owner does not grant access to a contract they did not create. Non-owned, deleted, and unknown contracts return `404 CONTRACT_NOT_FOUND`. Final downloads use private, no-store caching headers.

Poll the detail endpoint with a delay appropriate for human signing; increase the delay while status remains unchanged. When the contract completes, `completedAt` and `downloadUrl` become available. Download the PDF with authorization and archive it in your own records.

## Personal links and mandatory email codes

Every personal signer link requires fresh email proof in the browser, including links issued before this requirement was introduced. A previously marked verified token is not sufficient. Merely following a verification link performs safe inspection; email scanners cannot verify a recipient by fetching it.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/signing/verifications/{token}` | Inspects an active personal link and returns `email_verification_required`, a masked `emailHint` and the signing link. It sends no email and proves no identity. |
| `POST /api/signing/{token}/email-code/request` | JSON `{}` requests a code for the email assigned to that party. Returns the masked address, `expiresInSeconds: 600` and `retryAfterSeconds: 60`; never returns the code. |
| `POST /api/signing/{token}/email-code/verify` | JSON `{ "code": "123456" }` consumes the code once and sets the signer session cookie. Returns `verified: true` and the personal `signingUrl`. |

Use the personal URL in a browser and preserve its session cookie when calling the signing APIs. The session is HttpOnly, `SameSite=Strict`, Secure in hosted environments and restricted to `/api/`. It authorizes only that token, envelope, recipient and email for up to eight hours, clipped to the personal link's expiry. Another recipient's session cannot unlock the link. Revoked and expired tokens remain invalid. All personal document reads, source/final PDF downloads and signing mutations require this session. Bearer administration tokens do not substitute for the party's email proof or signature.

Codes are six digits, expire after ten minutes, allow at most five failed attempts and can be redeemed only once. Requests have a 60-second recipient cooldown, a five-per-hour recipient limit and a 20-per-hour IP limit. `429 EMAIL_CODE_RATE_LIMITED` includes `Retry-After` and `error.retryAfterSeconds`. Wrong, expired, consumed and exhausted codes all return `400 INVALID_EMAIL_CODE`. Missing proof returns `403 PARTNER_VERIFICATION_REQUIRED` with a masked `emailHint` and `verificationUrl`; unavailable email or verification configuration returns `503`. Cross-origin mutations are rejected.

After all parties have signed and the final private PDF has been committed, a durable outbox sends each party and the creator a personal secure download link. The message contains a link, not a PDF attachment. The creator receives `/my-documents/{id}` and uses their verified-email history login. Other parties receive `/completed-documents/{personal token}` and must complete the same email-code check before reading or downloading the final PDF through `/api/final-documents/{token}` and `/api/final-documents/{token}/pdf`. Final recipient links are valid for seven days from initial finalization. A creator who is also a party receives one creator link rather than duplicate completion messages. A raw final-document UUID is not a public download credential. Owner Bearer downloads through `/api/contracts/{id}/pdf` remain available.

Completion notifications are processed asynchronously; mail-provider failures do not undo a completed signature. Delivery uses stable mail idempotency keys, and attempts beyond the provider's safe retry window are held for manual review.

## Retry uncertain invitations

If the status is `delivery_failed`, inspect the contract and retry with a new operation key:

```sh
curl -X POST https://sign.amerged.com/api/contracts/CONTRACT_ID/retry-invitations \
  -H "Authorization: Bearer $SIGN_API_TOKEN" \
  -H "Idempotency-Key: retry-your-stable-reference"
```

The response reports `requeued` and `manualReview` counts. The same mail idempotency key and message are used for retries. An in-progress attempt is eligible for recovery after ten minutes. To avoid duplicate delivery after the provider's idempotency window, attempts older than 22 hours are marked `manual_review` and require investigation instead of automatic resending. A retry does not bypass ownership checks. Poll the contract status again after requeuing.

## Operational failures

Errors use `{ "error": { "code": "...", "message": "..." } }`. Draft creation needs private storage; email delivery is checked when sending with `delivery=email`. Manual delivery creates no invitation, but recipients still need working email delivery and `SIGN_OTP_SECRET` to verify their access.

For the existing create-and-send endpoint, missing storage or mail configuration returns `503` before a draft is created. An immediate mail provider rejection returns `502 EMAIL_DELIVERY_FAILED`; the partially prepared contract remains visible as a draft. The failed response is replayed for the original key, so retries cannot send duplicate invitations. Review that draft and delivery state before deliberately creating a replacement contract with a new key. If one queued invitation in a multi-recipient send fails, all signing links remain inactive, including links already emailed; no recipient can sign until delivery to all parties is confirmed.

Unexpected interruption after a command is claimed leaves the original command pending. It will not be automatically repeated because delivery may already have occurred; the operator should inspect the draft and mail state before taking further action.

## HTML and language scope

HTML upload and HTML-to-PDF conversion remain **OPEN**, pending a managed browser-rendering capability in ohmyho.st. The API accepts PDFs only. An HTML content type or a JSON HTML input is rejected with `400 INVALID_CONTRACT` and an explanation that HTML rendering is unavailable. A multipart HTML file returns `400 HTML_RENDERING_UNAVAILABLE`. No external renderer or third-party contract-processing service is used. Convert a template to a supported PDF before uploading it.

The DE/EN/NL selector changes frontend interface labels only. It does not translate PDF content, field data or emails, and it does not add a language preference to contract API payloads.

The API provides the application's existing basic electronic signing workflow. Qualified electronic signatures, stored templates, multiple documents, webhooks, and automatic reminders are outside this endpoint's current feature set.
