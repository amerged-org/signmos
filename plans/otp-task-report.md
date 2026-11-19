# Personal signer email-code implementation

Status: implemented; focused backend checks pass. No commit or deployment performed by this task.

## Identity boundary

Personal signer URLs identify a token; possession does not prove the recipient identity. Every personal signing read, source/final PDF, field placement, completion, decline, change request, completed metadata and completed PDF requires an email-code session bound to the exact token, envelope, recipient and normalized current email. An existing `verified_at` value does not authorize a browser. The old verification GET only returns a masked destination and signing locator and never grants access.

My Documents and `/api/v1` retain their separate existing verified-email authorization. History resolves a valid history session and matches the normalized participant email server-side; the Bearer API resolves the issued principal and current creator/signer role. These paths do not accept the personal signer token or OTP cookie as identity. No OTP operation creates an account or grants history/Bearer authority.

Public `/api/final-documents/{uuid}` document-ID bearer access is retired with 404; internal verified-history/domain calls can still use a document ID. Recipient final URLs use personal signer tokens plus OTP. Creator final access uses verified My Documents identity. Completed active signer links can request OTP; final-delivery extends their lifetime separately.

## Implementation

- `src/db/signer-email/`: challenge and session persistence; unbiased CSPRNG six-digit codes; HMAC-SHA256 with a dedicated required `SIGN_OTP_SECRET` of at least 32 characters and domain separation; only HMAC/session digests persisted.
- `database/omh-migrations/20261114120000_signer_email_otp.sql`: expand-only tables, token delete cascades, bounded attempts and supporting index.
- Code validity is ten minutes; five attempts maximum; successful redemption and session insertion are one atomic SQL operation. Concurrent verification can produce only one successful redemption. Resend replaces the previous challenge without restoring an exhausted challenge implicitly.
- Recipient cooldown is 60 seconds, recipient cap five sends/hour, defensive IP cap 20/hour. Atomic PostgreSQL upserts enforce cooldown and limits across concurrency. No OTP is sent when limited.
- Successful verification creates a random 256-bit HttpOnly cookie (`signmos_signer_session`, `Path=/api/`, `SameSite=Strict`, `Secure` in production/HTTPS), fixed eight-hour expiry clipped to signer-token expiry. Current token revocation, recipient-email change and expiry invalidate access.
- No code/session secret appears in URLs, JSON errors, audit events or application logging. Mail delivery failures return generic 503 without gateway diagnostics. Missing dedicated secret fails closed. Code delivery is mandatory, with no development response containing a code.
- Cookie mutations check same-origin/Fetch Metadata. Personal signing, OTP and final document responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Proof is folded into the existing signer-token query and final download/repair authorization query to retain the hosted ten-subrequest budget; rechecks preserve revocation/deletion races around storage awaits.

## API

| Method/path | Result |
| --- | --- |
| `GET /api/signing/verifications/{token}` | Scanner-safe inspection: `data.status=email_verification_required`, `emailHint`, `signingLink` |
| `POST /api/signing/{token}/email-code/request` | Optional `{}`; masked destination, 600-second lifetime, 60-second resend delay |
| `POST /api/signing/{token}/email-code/verify` | `{code:"123456"}`; sets scoped cookie and returns `verified:true`, `signingUrl` |

Errors: `PARTNER_VERIFICATION_REQUIRED` (403 with masked destination/recovery URL), `INVALID_EMAIL_CODE` (400, intentionally shared for mismatches/expiry/consumption/exhaustion), `EMAIL_CODE_RATE_LIMITED` (429 and `Retry-After`), `EMAIL_VERIFICATION_UNAVAILABLE` or `EMAIL_DELIVERY_UNAVAILABLE` (503), and lifecycle token errors (404/410). `VerifySignerEmailCodeSchema` is shared with the public contract.

## Evidence

Initial RED: the real PGlite/Hono test suite failed all eight initial behaviors: legacy tokens bypassed proof, scanner GET granted verification, OTP routes were missing, completed tokens/UUIDs bypassed identity. GREEN: core implementation passed those tests. A separate RED/GREEN check added non-cacheable protected responses.

Focused command (last run):

```sh
pnpm exec vitest run src/hono/api/signer-email-otp.test.ts src/hono/api/signing-flow.test.ts src/hono/api/change-request.test.ts src/hono/api/self-sign-completion-detail-link.test.ts src/hono/api/completed-documents.test.ts src/hono/api/partner-verification.test.ts src/db/envelope/signing-postgres.test.ts
```

Result: **7 files, 63 tests pass**, including 13 OTP-specific real PostgreSQL tests and 22 real SQL budget/race tests. OTP coverage includes all read/write bypasses, legacy `verified_at`, safe GET, hash-only storage, single use, exact expiry, five attempts, concurrent redemption and resend, recipient/IP limits, cross-origin rejection, cookie flags/scope, identity changes, session expiry, missing secret, redacted delivery errors, completed-link access and UUID rejection. Fresh completion, recorded-signature retry and legacy PDF repair stay within ten private subrequests; legacy repair success is exactly ten.

Changed files passed targeted Biome formatting/checks without warnings. Own production/test types passed after fixture signature fixes; a concurrent full typecheck at that moment still found the final-delivery agent's literal `contentType` fixture error, reported to its owner. Root owns final aggregate type/test/lint/build validation.

| Acceptance criterion | Status | Evidence |
| --- | --- | --- |
| Old and new open personal links require six-digit mailbox proof; no account | Verified | PGlite bypass/scanner tests; existing UI agent integration |
| Read/write/source/final/completed paths enforce exact identity | Verified | All seven personal read/write surfaces, final metadata/PDF, alternate recipient test |
| Expiry, attempt bound, resend/rate limits and single-use races | Verified | Real SQL exact-boundary, recipient/IP, concurrency tests |
| Legacy history/Bearer role authorization retained | Verified by review and aggregate regressions | Independent session/principal paths remain separate; root regression suites |
| Hosted request call budget and artifact revocation/deletion races | Verified | 22-test signing-postgres suite |
| Production private mail and live browser verification | Unverified here | Requires root's Dev/Prod release workflow; no deployment by this task |
| Aggregate types/tests/lint/build | Root-owned | Must report final combined checks after concurrent agents finish |
