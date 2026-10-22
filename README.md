# amerged Sign

Private contract sending and recipient signing, based on the MIT-licensed [Signmos](https://github.com/auditmos/signmos) project. This fork targets ohmyho.st in the EU at `https://sign.amerged.com`.

## Workflow

An allowlisted administrator signs in using a single-use email link. The private console uploads a PDF, adds an external recipient and sends the invitation. The recipient verifies their email, reviews the document and signs or declines. Completed PDFs include the captured signature/date and an audit summary. Administrators can view status, download completed PDFs and create or revoke API tokens.

`POST /api/contracts` provides the same send flow to server integrations. It requires a Bearer token and a durable Idempotency-Key. Status and downloads remain owner-authorized. See [API documentation](docs/contracts-api.md).

## Hosting and authentication

- TanStack Start and Hono run on OMH Workers.
- PostgreSQL is accessed through the private OMH binding with request-scoped Drizzle adapters; no database credentials enter the app.
- Private PDFs use OMH Files and immutable artifact versions.
- Email uses the OMH transactional-mail gateway, reached with the global `fetch` rather than a private binding (see [architecture](ARCHITECTURE.md)), and a verified sender domain.
- `SIGN_ADMIN_EMAILS` is an explicit email allowlist; public registration is disabled.
- Login sessions use Secure, HttpOnly, host-only cookies. Browser changes require same-origin requests and CSRF tokens. API keys are displayed once and stored as hashes.
- Recipient signing/verification links remain accessible without administrator credentials and retain their envelope-specific authorization.

The deployment configuration is [ohmyhost.yaml](ohmyhost.yaml). Development and production use isolated databases and files. New schema migrations live in `database/omh-migrations` and are applied by OMH; the upstream Neon seed and direct migration commands are intentionally retired. First login creates the necessary identity, so no default password or seed account exists.

## Configuration

Supply runtime configuration privately through OMH:

| Name | Purpose |
| --- | --- |
| SIGN_ADMIN_EMAILS | Comma-separated administrator allowlist |
| SIGN_FROM_EMAIL | Exact verified email sender |
| SIGN_REPLY_TO_EMAIL | Existing reply mailbox |
| APP_BASE_URL | Trusted origin for this environment |
| CLOUDFLARE_ENV | `production` for both hosted environments |

OMH injects its private database and file bindings and the mail gateway URL and key (`OHMYHOST_MAIL_GATEWAY_URL`, `OHMYHOST_MAIL_KEY`); mail does not use the private mail binding. No Resend key, raw R2 credentials or database connection string is needed. Resend transport remains only for upstream local fixtures.

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

The convenience API currently sends one PDF to one external signer and can append a dedicated signing page or use explicit field positions. The inherited signing engine remains a pilot and does not implement qualified trust-service signatures. UI and API document the bounded PDF policy needed by the hosting runtime. Original upstream submission evidence remains available in Git history; it is not release evidence for this fork.

## License

MIT. Original Signmos copyright and third-party notices are preserved in [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
