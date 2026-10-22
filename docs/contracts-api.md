# amerged Sign contracts API

The private console and API run at `https://sign.amerged.com`. Only email addresses listed in the deployment's `SIGN_ADMIN_EMAILS` setting can administer contracts. Recipient signing links remain accessible without an administrator login, and require the existing recipient email verification flow.

## Authentication

For integrations, sign in to the private amerged Sign console and create a token in the API section and send it as `Authorization: Bearer <token>`. Keep the secret on your server. The request sender always comes from the authenticated email; payloads cannot supply another sender.

The browser console uses an HttpOnly session cookie. Browser mutations additionally require the same origin and the `X-CSRF-Token` obtained from the session endpoint. Creating or revoking API tokens requires the verified administrator session and its CSRF token.

## Send a contract

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

## Operational failures

Errors use `{ "error": { "code": "...", "message": "..." } }`. Missing storage or mail configuration returns `503` before a draft is created. A mail provider rejection returns `502 EMAIL_DELIVERY_FAILED`; the partially prepared contract remains visible as a draft. The failed response is replayed for the original key, so retries cannot send duplicate invitations. Review that draft and delivery state before deliberately creating a replacement contract with a new key.

The hosting platform's own refusals after the draft exists are recorded and replayed the same way, and the draft's signing link stays inactive:

| Status | Code | Meaning |
| --- | --- | --- |
| `429` | `MAIL_DAILY_LIMIT` | The project's daily email limit (shared by Dev and Prod, UTC day) is used up; no invitation was sent. |
| `423` | `MAIL_SENDER_SUSPENDED` | Sending is suspended after bounces or complaints; no invitation was sent. |
| `402` | `PAID_PLAN_REQUIRED`, `INSUFFICIENT_ORGANIZATION_CREDITS`, `PROJECT_BUDGET_EXCEEDED` | The workspace cannot pay for the email; no invitation was sent. |
| `503` | `PLATFORM_CONFIGURATION_INVALID` | A platform service refused the request, usually a sender address that the mail binding does not list; no invitation was sent. |
| `503` | `EMAIL_DELIVERY_UNCERTAIN`, `PLATFORM_SERVICE_UNAVAILABLE` | The invitation may or may not have been delivered. Check with the recipient, then create a new request with a new key. |

Unexpected interruption after a command is claimed leaves the original command pending. It will not be automatically repeated because delivery may already have occurred; the operator should inspect the draft and mail state before taking further action. Such errors, and every other unexpected API failure, answer JSON (`INTERNAL_ERROR`, `PLATFORM_SERVICE_ERROR` or `DATABASE_ERROR`) with a stable `reason` code instead of plain text.

The platform's `reason` goes only to the administrator who calls this API, with the console session or a Bearer token. The signer and download-link routes answer the same failure without it, because a code such as `paid_plan_required` or `project_budget_exceeded` would tell a recipient about the sender's plan or budget.

The API provides the application's existing basic electronic signing workflow. Qualified electronic signatures, templates, multiple documents, webhooks, and automatic reminders are outside this endpoint's current feature set.
