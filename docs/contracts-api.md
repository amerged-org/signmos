# amerged Sign contracts API

The private console and API run at `https://sign.amerged.com`. Only email addresses listed in the deployment's `SIGN_ADMIN_EMAILS` or `SIGN_EXTRA_ADMIN_EMAILS` setting can administer contracts. Recipient signing links remain accessible without an administrator login, and require the existing recipient email verification flow.

## Authentication

For integrations, sign in to the private amerged Sign console and create a token in the API section and send it as `Authorization: Bearer <token>`. Keep the secret on your server. The request sender always comes from the authenticated email; payloads cannot supply another sender.

The browser console uses an HttpOnly session cookie. Browser mutations additionally require the same origin and the `X-CSRF-Token` obtained from the session endpoint. Creating or revoking API tokens requires the verified administrator session and its CSRF token.

## Send a PDF with placeholders

`POST /api/contracts` accepts a PDF and a JSON definition as `multipart/form-data`. The machine-readable OpenAPI contract is available at `/openapi.json`. Use an administrator's Bearer token and an `Idempotency-Key` header. Reuse the same key and the same PDF and definition to safely retry a request. Reusing a key with different content returns `409 IDEMPOTENCY_CONFLICT`.

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

Supported field types are `text`, `date`, `checkbox`, and `signature`. The field name starts with a letter or underscore and may contain letters, numbers, underscores and hyphens. Provide one to three recipients. Every recipient needs at least one field and must differ from the sender. Recipients may complete only their own fields, and their signing links become active together after every invitation has been accepted for delivery. Required fields must be completed; optional fields can remain empty. All recipients must complete their part before the finished PDF is available.

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

Signing links and raw signer credentials are delivered to the intended recipient by email and are not returned by this API.

## Read status and download

| Endpoint | Response |
| --- | --- |
| `GET /api/contracts` | `{ "data": [...] }`, up to the latest 100 contracts owned by the authenticated email, newest first. |
| `GET /api/contracts/{id}` | `{ "data": { ... } }` with current status, recipient progress, and final-download availability. |
| `GET /api/contracts/{id}/pdf` | Completed PDF with signatures and audit certificate. Returns `409 FINAL_PDF_NOT_READY` until complete. |

Use the same authentication for all reads. A valid token for another allowlisted owner does not grant access to a contract they did not create. Non-owned, deleted, and unknown contracts return `404 CONTRACT_NOT_FOUND`. Final downloads use private, no-store caching headers.

Poll the detail endpoint with a delay appropriate for human signing; increase the delay while status remains unchanged. When the contract completes, `completedAt` and `downloadUrl` become available. Download the PDF with authorization and archive it in your own records.

## Retry uncertain invitations

If the status is `delivery_failed`, inspect the contract and retry with a new operation key:

```sh
curl -X POST https://sign.amerged.com/api/contracts/CONTRACT_ID/retry-invitations \
  -H "Authorization: Bearer $SIGN_API_TOKEN" \
  -H "Idempotency-Key: retry-your-stable-reference"
```

The response reports `requeued` and `manualReview` counts. The same mail idempotency key and message are used for retries. An in-progress attempt is eligible for recovery after ten minutes. To avoid duplicate delivery after the provider's idempotency window, attempts older than 22 hours are marked `manual_review` and require investigation instead of automatic resending. A retry does not bypass ownership checks. Poll the contract status again after requeuing.

## Operational failures

Errors use `{ "error": { "code": "...", "message": "..." } }`. Missing storage or mail configuration returns `503` before a draft is created. A mail provider rejection returns `502 EMAIL_DELIVERY_FAILED`; the partially prepared contract remains visible as a draft. The failed response is replayed for the original key, so retries cannot send duplicate invitations. Review that draft and delivery state before deliberately creating a replacement contract with a new key. If one invitation in a multi-recipient send fails, all signing links remain inactive, including links already emailed; no recipient can sign the incomplete draft.

Unexpected interruption after a command is claimed leaves the original command pending. It will not be automatically repeated because delivery may already have occurred; the operator should inspect the draft and mail state before taking further action.

The API provides the application's existing basic electronic signing workflow. Qualified electronic signatures, templates, multiple documents, webhooks, and automatic reminders are outside this endpoint's current feature set.
