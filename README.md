# amerged Sign

Private contract sending and recipient signing, based on the MIT-licensed [Signmos](https://github.com/auditmos/signmos) project. This fork is hosted on ohmyho.st at `https://sign.amerged.com`. The existing hosting project reports the US region; the configured private file jurisdiction is EU. Verify the effective location of each service with the hosting provider rather than treating either setting as a statement about all processing.

## Workflow

An allowlisted administrator signs in using a single-use email link. The private console uploads a PDF, adds an external recipient and sends the invitation. Each recipient opens a personal link, enters a six-digit code sent to their email address, and reviews and signs or declines without creating an account. Existing open links also require this code. Completed PDFs include the captured signature/date and an audit summary. Administrators can view status, download completed PDFs and create or revoke API tokens.

Server integrations can create a draft through `POST /api/contracts/drafts`, read it, update its title/parties/fields, replace the PDF and definition, and then send or delete it. The PDF and definition become immutable when sent. Sending chooses `delivery=email` or `delivery=manual` and returns personal signing links to the authenticated owner; manual delivery skips invitation emails but still requires email codes when recipients open their links. Include the sender as a party explicitly if they must sign; no signature is inferred or fabricated. All parties must finish before the final PDF becomes available.

`POST /api/contracts` retains the existing create-and-send flow, including legacy JSON and multipart PDF + JSON placeholder definitions for text, date, checkbox and signature fields. Email invitations are queued in the background for multipart requests and explicit draft sends. Mutations require an administrator Bearer token (or the protected browser session) and a durable `Idempotency-Key`; reads, links and downloads remain owner-authorized. After completion, a durable mail queue delivers secure personal download links to all parties and the creator, without PDF attachments. See [API documentation](docs/contracts-api.md) and `/openapi.json`.

## Hosting and authentication

- TanStack Start and Hono run on OMH Workers.
- PostgreSQL is accessed through the private OMH binding with request-scoped Drizzle adapters; no database credentials enter the app.
- Private PDFs use OMH Files and immutable artifact versions.
- Email uses the private OMH transactional-mail gateway and a verified sender domain.
- `SIGN_ADMIN_EMAILS` is an explicit email allowlist; public registration is disabled.
- Login sessions use Secure, HttpOnly, host-only cookies. Browser changes require same-origin requests and CSRF tokens. API keys are displayed once and stored as hashes.
- Recipient links require a six-digit email code and a recipient-bound HttpOnly session; an administrator login is not required.

The deployment configuration is [ohmyhost.yaml](ohmyhost.yaml). Development and production use isolated databases and files. New schema migrations live in `database/omh-migrations` and are applied by OMH; the upstream Neon seed and direct migration commands are intentionally retired. First login creates the necessary identity, so no default password or seed account exists.

## Configuration

Supply runtime configuration privately through OMH:

| Name | Purpose |
| --- | --- |
| SIGN_ADMIN_EMAILS | Comma-separated administrator allowlist |
| SIGN_EXTRA_ADMIN_EMAILS | Additional comma-separated administrator allowlist; does not replace existing administrators |
| SIGN_FROM_EMAIL | Exact verified email sender |
| SIGN_REPLY_TO_EMAIL | Existing reply mailbox |
| SIGN_OTP_SECRET | Private secret of at least 32 characters for recipient email-code verification |
| APP_BASE_URL | Trusted origin for this environment |
| CLOUDFLARE_ENV | `production` for both hosted environments |

OMH injects its private database, file and mail bindings. No Resend key, raw R2 credentials or database connection string is needed. Resend transport remains only for upstream local fixtures.

## Development and verification

Use Node.js 24 and the pinned `pnpm@11.20.0`.

```sh
pnpm install --ignore-scripts
pnpm types
pnpm test
pnpm lint
pnpm build
pnpm omh:check
```

Local tests use isolated adapters and synthetic PDFs; they do not establish hosted email delivery. Hosted readiness additionally requires login, API send/retry, recipient verification/signing, completed-PDF download and logout/revocation checks. No runtime test bypass is enabled in production.

See [database adapter notes](docs/DATABASE_OMH.md), [architecture](ARCHITECTURE.md) and [OMH implementation scope](plans/amerged-sign-omh-prd.md).

## Scope

The API-first draft flow accepts PDF + JSON; there is no stored-template management. HTML upload and HTML-to-PDF rendering remain **OPEN** until ohmyho.st provides a managed browser-rendering capability. HTML requests are explicitly rejected; no external rendering service processes contracts. The frontend language selector changes interface labels only; it does not translate PDF content, field data or emails.

The legacy convenience API sends one PDF to one external signer and can append a dedicated signing page or use explicit field positions. The multipart API supports up to three parties and PDF placeholders. The inherited signing engine remains a pilot and does not implement qualified trust-service signatures. UI and API document the bounded PDF policy needed by the hosting runtime. Original upstream submission evidence remains available in Git history; it is not release evidence for this fork.

## License

MIT. Original Signmos copyright and third-party notices are preserved in [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
