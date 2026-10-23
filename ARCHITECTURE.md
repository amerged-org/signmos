# amerged Sign fork architecture

The amerged fork keeps the upstream document lifecycle described below and changes its hosting boundaries: request-scoped OMH PostgreSQL via `src/db/omh-driver.ts`, private immutable files via `src/omh/storage.ts`, and transactional mail via `src/omh/mail.ts`. Mail is sent with the global `fetch` to `OHMYHOST_MAIL_GATEWAY_URL` because the platform's egress-policy Worker forwards that request privately to the mail gateway, whereas the private service binding `OHMYHOST_MAIL_GATEWAY` answers 503 `mail_gateway_unavailable` while the egress policy is attached (observed 2026-10-22); revisit this when the platform repairs the binding. `src/omh/hosted-request.ts`, run by the global request middleware in `src/omh/hosted-middleware.ts`, initializes the request-scoped database and file bindings and enforces the administrator gate before dispatch. `src/omh/auth-*` owns allowlisted email-link login, secure sessions, CSRF and token management. `src/omh/contracts*` owns the convenience send/read/download API; owner authorization remains explicit. The private browser console lives under `src/components/console`. Recipient verification/signing pages remain separate public, token-authorized entry points. See `plans/amerged-sign-omh-prd.md` for the fork acceptance scope.

The administrator gate carries verified identity only to its exact sanitized dispatch request inside an `AsyncLocalStorage` scope; handler checks still enforce the current allowlist, credential class and browser CSRF. API-token management batches its short-lived identity bridge and cleanup, retaining real audit/session FKs and the five-token cap with bounded contention retries. Contract list/detail reads use one parameterized SQL projection, and final download rechecks the owner-scoped immutable locator after reading the private file. `contracts-create.ts` claims a fresh command, prepares the draft/source/recipient/fields/manifest atomically, uploads the private source, sends the invitation and atomically activates the signer link with the exact response receipt. Recipient completion batches typed reads and guarded writes; final artifact locators are registered before upload, and completed state follows verified storage. Durable deletion intent closes final reads and artifact writes before the deletion inventory is captured. Guarded mutations lock the envelope in a separate first transaction statement so the following authority check sees a fresh snapshot after any lock wait. Database transactions never span a file transfer or email request.

The owner notice after a signature is best effort: it is attempted only after the signature is stored, a refusal or timeout never undoes the signing, and the send gives up after 15 s (`OWNER_NOTICE_TIMEOUT_MILLISECONDS` in `src/omh/mail.ts`) because the signer's answer waits for it, whereas every other managed mail, such as login and invitation, waits up to 25 s. The platform has recorded sends of 5-10 s and 5-13 s (its PLAN.md, `apps/mail-gateway/src/resend-send.ts` and the W26 specification), so both deadlines lie above that range; they are choices, not measurements, until they are timed on the platform.

`email_send_records` rows are notification requests recorded with the state change they announce, not delivery receipts: the mail gateway's ledger, not this table, is the record of what was sent, and the owner notice row `partner_signed_notice_requested` is written in the signature transaction before its best-effort send, so it stays when that send is refused or times out.

The original direct-Neon migration/seed/deploy commands are retired in this fork. OMH applies fresh additive schema under `database/omh-migrations`; no production rows or credentials are imported from upstream. The inherited code map below provides context for the retained domain modules.

# ARCHITECTURE

This is the stable physical map for signmos. It names important files and modules but avoids deep links so the document stays useful as code moves. Use symbol search and filenames from this map when navigating.

## Problem

Signmos implements a lightweight no-account e-signature pilot. A sender creates a self-sign or two-party envelope, uploads one PDF, prepares signature/date fields, and completes signing through verified email links. When all recipients complete, the system stores a final PDF artifact with flattened values and an audit summary. Returning participants can use a temporary verified-email My Documents session to recover retained work without exposing envelope process credentials. Agentic mode adds email-verified personal Bearer tokens and a role-equivalent `/api/v1` document surface without turning those tokens into password accounts or credential-management authority.

The production shape is Cloudflare Workers plus R2 for document artifacts, Neon Postgres plus Drizzle for relational state, Hono for JSON APIs, and TanStack Start for routes and SSR.

## Request Flow

The ohmyho.st build bundles TanStack Start's default server entry and writes its own Worker configuration, so the app has no custom Worker entry. Every request first passes the global request middleware registered in `src/start.tsx` (`src/omh/hosted-middleware.ts`), which runs `serveHostedRequest` in `src/omh/hosted-request.ts`.

1. The middleware scopes the private OMH database (`withDatabase`) and the document storage to the request and applies the administrator gate (`authorizeHostedRequest`).
2. Paths under `/api/` are delegated to `apiHono`.
3. `/agent.md` and `/openapi.json` are delegated to the public Agent contract publisher.
4. Other paths continue into the TanStack Start handler (`next()`).
5. Hono route modules validate HTTP input and delegate persistence/lifecycle work to DB domain modules.
6. DB domain modules use Drizzle through `getDb`.
7. PDF source and final artifacts use the `DOCUMENTS_BUCKET` R2 binding.

## Codemap

### Worker And App Shell

- `src/omh/hosted-request.ts` is the only place that splits Hono API traffic from TanStack app traffic; `src/omh/hosted-middleware.ts` runs it as the first global request middleware (`src/start.tsx`). There is no custom Worker entry: `wrangler.jsonc` points at `@tanstack/react-start/server-entry`, as the ohmyho.st build does.
- `src/start.tsx`, `src/router.tsx`, and `src/routes/__root.tsx` set up the TanStack app shell.
- `src/routeTree.gen.ts` is generated by TanStack Router.
- `src/integrations/tanstack-query/root-provider.tsx` wires TanStack Query into the React tree.

### Hono API Layer

- `src/hono/factory.ts` creates typed Hono instances with Cloudflare bindings.
- `src/hono/api.ts` mounts health, clients, envelopes/preparation, signing, final-document, history, Agentic management, and Agent `/api/v1` domains.
- `src/hono/api/envelopes.ts` owns envelope lifecycle HTTP routes: sender start/verification, create, source PDF upload/revision, recipients, fields, send/resend, controls, status, retention, and sender-authorized final PDF download.
- `src/hono/api/envelope-preparation.ts` owns signature-profile and default-field preparation endpoints.
- `src/hono/api/signing.ts` owns signer-token routes: partner verification, source PDF access, resolve session, complete signing, change request, decline, and final PDF download.
- `src/hono/api/final-documents.ts` owns completed-document bearer-link detail and PDF access.
- `src/hono/api/history-access.ts` owns passwordless history requests, scanner-safe link redemption, history sessions, catalog/detail reads, and session-authorized final PDF access. `history-human-review.ts` owns matching-session review reads, current-PDF access, and approve/reject decisions.
- `src/hono/api/history-envelope-start.ts` starts a verified draft from an active history session.
- `src/hono/api/history-creator.ts` and `src/hono/api/history-signing.ts` adapt history-authorized creator and signer recovery actions.
- `src/hono/api/agentic.ts` owns Agentic email verification, management-session, and browser token-generation routes.
- `src/hono/api/agent-v1.ts` owns the Bearer gateway, per-token/IP rate limiting, and universal mutation-idempotency guard for the stable `/api/v1` contract. Focused `agent-v1-*` route modules cover catalog/detail, source PDF, signatures/fields, two-party delivery, partner decisions, revision, creator controls, pending human-review creation/notification, and exact-token command polling.
- `src/hono/public-agent-contract.ts` publishes `/agent.md` and `/openapi.json` from the same runtime schemas and route operation metadata used by `/api/v1`.
- `src/hono/api/clients.ts` and `src/hono/api/health.ts` are starter/demo and health surfaces, not core signing workflow.

### Envelope Domain

- `src/db/envelope/table.ts` defines relational tables for envelopes, source/final documents, recipients, tokens, email send records, fields, field values, audit events, and idempotency records.
- `src/db/envelope/schema.ts` defines Zod schemas, domain types, request/response shapes, lifecycle enums, and response adapters.
- `src/db/envelope/queries.ts` owns core envelope persistence; focused modules such as `sender-start.ts`, `source-documents.ts`, `preparation.ts`, `signing.ts`, `controls.ts`, and `completed-documents.ts` own their lifecycle slices.
- `src/db/envelope/finalization.ts` owns final PDF artifact creation, final-document metadata, final availability status, and final PDF lookup.
- `src/db/envelope/index.ts` is the public import boundary for the envelope domain.

### History Access Domain

- `src/db/history-access/table.ts` defines hashed access-link/session persistence, request and delivery records, and the separate history security-event stream.
- `src/db/history-access/request.ts`, `request-abuse.ts`, and `credential-authority.ts` own enumeration-safe access requests, rate limits, single-use link redemption, fixed sessions, and revocation.
- `src/db/history-access/catalog.ts` projects the authorized retained-document catalog, session identity, search/filter/pagination, role-aware groups, and allowed actions.
- `src/db/history-access/creator-gateway.ts`, `signer-gateway.ts`, and `document-gateway.ts` re-check normalized-email role and current envelope state for every recovery path.
- `src/db/history-access/session-envelope-start.ts` creates an idempotent already-verified draft from an active history session.
- `src/db/history-access/security-audit.ts` records credential/session/document access separately from the user-facing envelope audit timeline.
- `src/db/history-access/index.ts` is the public import boundary for the history-access domain.

### Agentic Access Domain

- `src/db/agentic-access/table.ts` defines hashed Agentic links, 15-minute management sessions, named API-token metadata, delivery records, and security events.
- `src/db/agentic-access/request.ts` and `credential-authority.ts` own enumeration-safe access requests, fragment-delivered link credentials, atomic redemption, and exact expiry boundaries.
- `src/db/agentic-access/token-authority.ts` generates one-time `signmos_` secrets from 256 bits of CSPRNG material and persists only deterministic hashes plus safe hints.
- `src/db/agentic-access/bearer-principal.ts` resolves the verified email/token principal and records agent-attributed sensitive reads.
- `src/db/agentic-access/command-authority.ts` claims every mutation by token and idempotency key, stores the exact result, replays identical retries, and rejects changed reuse.
- `src/db/agentic-access/human-review-authority.ts`, `human-review-decision-authority.ts`, and `human-review-queue.ts` bind protected actions to the exact token, payload, source PDF, reviewer role, 24-hour lifetime, matching-session decision, and terminal polling result.
- `src/db/agentic-access/documents.ts`, `self-signing.ts`, `two-party.ts`, and `partner-signing.ts` adapt normalized-email creator/signer authority to the existing envelope lifecycle.
- `src/db/agentic-access/security-audit.ts` records safe agent attribution without raw link, session, token, or hash material.
- `src/db/agentic-access/schema.ts` is the shared runtime/OpenAPI trust boundary, and `index.ts` is the domain's narrow public interface.

### Other DB Domains

- `src/db/setup.ts` owns Neon/Drizzle initialization and the `getDb` access point.
- `src/db/schema.ts` re-exports tables for migrations.
- `src/db/client/*` is a starter client demo domain.
- `src/db/health/*` supports health checks.
- `src/db/migrations/dev/*` contains generated development migrations.

### Routes And Feature UI

- `src/routes/index.tsx` renders the four-choice unselected self-sign/two-party/My Documents/Agentic task chooser.
- `src/components/sender/start-envelope-page.tsx` owns task selection plus sender initiation, Turnstile submission, and validation.
- `src/components/history/history-request-form.tsx` owns the privacy-safe My Documents access request.
- `src/routes/history-access.$credential.tsx` and `src/components/history/history-access-confirmation-page.tsx` provide scanner-safe history-link confirmation and redemption.
- `src/routes/my-documents*.tsx` mount the catalog, completed detail, creator recovery, and recovered-signer routes through nested outlets.
- `src/routes/human-review.$reviewId.tsx` and `src/components/history/human-review-page.tsx` render the exact protected-action review and return unauthenticated reviewers through passwordless My Documents verification.
- `src/components/history/history-documents-page.tsx` owns catalog queries, recovery states, and sign-out; `history-envelope-start.tsx` starts a draft from the verified session.
- `src/components/history/history-creator-page.tsx`, `history-creator-controls.tsx`, and `history-document-detail-page.tsx` own creator recovery/controls and completed detail.
- `src/routes/source-pdf-upload.tsx` adapts sender session query params into the upload/revision screen.
- `src/components/sender/source-pdf-upload-panel.tsx` owns source PDF upload and validation states.
- `src/components/sender/signature-profile-panel.tsx` owns drawn and typed signature profile creation.
- `src/routes/envelope-fields.tsx` renders the envelope preparation surface.
- `src/components/envelopes/envelope-preparation-page.tsx` creates a review envelope and wires signature profiles to field placement.
- `src/components/envelopes/field-editor.tsx` is the current field placement form.
- `src/routes/signing.$token.tsx` adapts the magic-link token route to the signer page.
- `src/components/signing/signer-page.tsx` loads assigned fields and posts completion, change requests, and decline for process-link or recovered-history access.
- `src/routes/completed-documents.$token.tsx` and `src/components/completed-documents/completed-document-page.tsx` render process-link completed details.
- `src/routes/manual-signing-smoke.tsx` and `src/components/signing/manual-smoke-page.tsx` provide the local browser-driven full workflow smoke path.
- `src/routes/agentic-access.tsx` removes the emailed fragment credential from browser history before scanner-safe inspection; `src/routes/agentic-console.tsx` hosts one-time token generation and secret-free agent guidance.
- `src/routes/clients.tsx` and `src/components/clients/*` remain a demo client CRUD surface outside the signing workflow.

### Design System And Styling

- `docs/DESIGN.md` is the design-system contract: layout, surfaces, color, copy, and which shared component to reach for.
- `src/components/ui/*` contains generated Shadcn primitives.
- `src/components/layout/*` owns the page skeleton (`PageShell`, `PageHeader`, `Wordmark`).
- `src/components/patterns/*` owns shared app patterns (`Panel`, `StatusBadge`, `TextLink`/`BackLink`, `NativeSelect`, `EmptyState`, `LoadingText`).
- `src/styles.css` contains Tailwind CSS v4 setup, Shadcn CSS variables, brand theme tokens, and the self-hosted Inter Variable font faces (`public/fonts/`).
- `src/lib/utils.ts` contains shared class-name utility behavior.
- `src/components/theme/*` owns the app theme provider.

### Tests

- API behavior is covered under `src/hono/api/*.test.ts`.
- Envelope UI behavior is covered beside feature components under `src/components/envelopes`, `src/components/history`, `src/components/sender`, and `src/components/signing`.
- `src/release/my-documents-release-contract.test.ts` guards credential hygiene, scope, nested route mounting, and retained release evidence.
- `src/release/agentic-mode-release-contract.test.ts` guards runtime/OpenAPI parity, complete public guidance, capability mapping, measured evidence, and all 44 Agentic PRD stories.
- `src/release/agent-credential-redaction.test.ts`, `agentic-calibrate.test.ts`, and `agentic-smoke.test.ts` guard credential hygiene plus the runnable measurement/smoke entry points.
- Core error helpers are covered in `src/core/errors.test.ts`.
- Route files under `src/routes` are excluded from test discovery; test the component or API boundary instead.

## Architectural Invariants

- Hono handlers are HTTP adapters. They validate input, call domain functions, and map domain results/errors to stable JSON.
- SQL and Drizzle details stay in `src/db/*`; route and component code should not construct queries.
- The envelope domain owns lifecycle state transitions. UI and API layers should not duplicate lifecycle rules.
- Zod schemas live at trust boundaries and are exported from domain modules. Avoid inline validation schemas in route handlers unless the shape is tiny and local.
- R2 access happens through Cloudflare bindings, not global config or `process.env`.
- Generated files are generated. Do not edit `src/routeTree.gen.ts`, generated migrations, `worker-configuration.d.ts`, or Shadcn primitives by hand.
- Source files stay under 500 lines. Split by real module boundary, not by arbitrary helper extraction.
- Tests assert behavior through public boundaries and avoid internal mocks.

## Cross-Cutting Concerns

### Validation And Errors

Known API failures should return machine-readable JSON with stable codes. The lifecycle API uses codes such as `UNAUTHORIZED`, `INVALID_ACTION`, `INVALID_SOURCE_PDF`, `SOURCE_PDF_TOO_LARGE`, `INVALID_RECIPIENTS`, `INVALID_FIELDS`, `EXPIRED_TOKEN`, and `FINAL_PDF_NOT_FOUND`. History recovery adds structured link/session/document/role/state codes such as `HISTORY_LINK_EXPIRED`, `HISTORY_SESSION_REQUIRED`, `HISTORY_SESSION_EXPIRED`, `HISTORY_DOCUMENT_NOT_FOUND`, and `HISTORY_CREATOR_ACTION_BLOCKED`, each with a recovery URL where applicable.

`src/core/errors.ts` contains shared `AppError`, `Result<T>`, and Postgres unique-violation helpers. New domain behavior should prefer typed errors or structured results over untyped thrown strings.

### Idempotency

Envelope creation, source PDF upload, public history requests, and history-session envelope start use idempotency records or request claims. Every `/api/v1` `POST`, `PUT`, `PATCH`, and `DELETE` is guarded by `agenticCommandRecords`: identical token/key/operation/payload retries replay the original status and body, while changed reuse returns `IDEMPOTENCY_CONFLICT`. New mutating lifecycle endpoints must define the operation name, fingerprint, idempotency scope, and exact replay behavior before implementation.

### Identity And Authorization

Signmos has no password account. Existing sender/signer/final-document credentials remain process-specific. My Documents adds a parallel normalized-email identity proven by a single-use link and held in a fixed, revocable HTTP-only session. History routes must authorize both the email's envelope role and current lifecycle state, must not reveal process bearer credentials, and must require same-origin protection for cookie-authenticated mutations.

Agentic mode adds a separate 30-minute single-use email credential, a 15-minute HTTP-only management session, and long-lived hash-only personal Bearer tokens. Management cookies cannot authorize `/api/v1`, Bearer tokens cannot substitute for browser management, and every sensitive Bearer operation records normalized email plus safe token identity with `actorType: "agent"`.

### Agent API Rate Limits And Public Contract

Authenticated `/api/v1` requests consume fixed-window per-token and defensive per-IP limits through `src/hono/api/agent-v1-rate-limit.ts` and the shared `rate_limit_records` table. Successful responses expose limit/remaining/reset metadata; limited responses add stable `429` JSON and `Retry-After`. Numeric policy lives in `agent-rate-limit-policy.ts` and must be changed only with retained representative calibration evidence.

`/openapi.json` is the machine contract and must remain identical to runtime methods, paths, Bearer requirements, schemas, binary bodies, errors, and idempotency rules. `/agent.md` is the human/agent operating contract for workflows, recovery, polling/backoff, goal discipline, and secret handling. Do not maintain a second hand-written full `/api/v1` endpoint list in repository docs.

### Document Storage

Envelope metadata lives in Neon. Source and final PDFs live in R2 under envelope-scoped keys. The database stores R2 key, content type, byte size, and SHA-256 hash so API status and audit behavior do not need to inspect R2 for every decision.

### Time

Sender verification, history access links, and Agentic access links expire after 30 minutes; Agentic management sessions expire after 15 minutes, history sessions after a fixed eight hours, and signer tokens after seven days. Tests that depend on time should control time explicitly through a boundary such as headers, fake timers, or injectable clock behavior.

### UI

Route files should stay thin. Feature components own UI state and fetch/mutation interactions. Shared UI primitives come from Shadcn and should be changed through the component generator or wrapper components, not manual edits inside `src/components/ui`.

### Issue-Driven Work

For future pilot issues, start from the live issue acceptance criteria and load the local TDD skill for the implementation loop. The architecture map should help choose the right public boundary: HTTP API for lifecycle work, component boundary for signer/editor UX, or R2/PDF artifact boundary for finalization. Agentic changes must also preserve the runtime/OpenAPI drift contract, universal mutation-idempotency enumeration, credential redaction scan, capability matrix, and browser compatibility evidence.
