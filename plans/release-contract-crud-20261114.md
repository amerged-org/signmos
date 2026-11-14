# Contract CRUD release verification — 2026-11-14

Runtime commit: `7259e423c4f6d901e29f4dacc79c85302382b71d`. Branch: `codex/amerged-sign-omh`.
Exact Dev artifact: `sha256:4dbd38cebbb2e5fe23c7571632c740e92260e8b2ab48cfe097e22a1d47fe27ee`.
Dev deployment: `01M7D3G4DQ18G0BD0H9QXB9SKH`; promoted without rebuilding to Prod deployment `01M7D3VRK7BN0BMRMHV1TBWH5S`.
Prod operation `01M7D3VRK7BN0BMRMHV1TBWH5R` succeeded at 2026-11-14 13:28:29 UTC. No Dev data or credentials were copied.
Live origin: https://sign.amerged.com. Existing US compute / EU private-file jurisdiction preserved.

## Verification

- All 688 tests in 145 files passed. Types, Knip, build and diff checks passed. Lint passed with 11 advisory warnings.
- Independent CRUD and OTP/delivery reviews resolved all reproduced findings; see `crud-review.md` and `otp-delivery-review.md`.
- Protected Dev exercised real PDF/JSON creation, read, PATCH, PDF replacement, manual send, explicit unsigned creator participation, OTP denial, post-send immutability, cancellation and private erasure. See `hosted-crud-verification.md`.
- Source replacement uses nine private calls; measured failure/race paths and scheduled delivery stay within ten. Gateway protocol tests use the installed storage SDK.
- Dedicated OTP secrets exist separately in Dev and Prod. Secret values, private share URLs, credentials, signing links and PDF bytes are absent from evidence.

Production checks completed 2026-11-14T13:29:46.255686+00:00:

| HTTP check | Status |
| --- | ---: |
| GET /api/health/live | 200 |
| GET /openapi.json | 200 |
| GET /login | 200 |
| GET /api/contracts | 403 |
| POST /api/contracts/drafts | 403 |
| GET /api/signing/release-check-token-not-real | 404 |
| GET /api/final-documents/00000000-0000-4000-8000-000000000000/pdf | 404 |

OpenAPI verified 10 CRUD/OTP operations. Login HTML retains the shared brand/language header and CSP.
Existing Prod envelope/source/final counts remained 1 / 1 / 0 across additive migrations. OTP and final-delivery tables are present.
New Prod cron at 2026-11-14T13:30:00.000Z succeeded with HTTP 204 on the promoted deployment.

## Scope and limits

The final fixed Dev release also verified live `STORAGE_DELETE_PENDING`, `retryable`, `retryAt`, the matching absolute `Retry-After` and exact idempotent replay. A fresh-key delete returned 200 at 2026-11-14 13:32:03 UTC after the deadline. Private erasure and persisted deleted status were confirmed; all temporary Dev credentials had active count zero by 13:32:44 UTC. No synthetic files remain.

HTML-to-PDF remains intentionally OPEN. Managed Browser Rendering feature request: `01M7D128EQPZ47BDZ2TCTJEHY1`.
The six-digit mailbox proof, rendered signed PDF and durable final-mail workflow have end-to-end automated SQL/SDK/PDF coverage. Customer-mailbox delivery and a full personal signing journey were not manually repeated in production; no test emails were sent. This report makes no worst-case cold CPU claim for maximum-size PDFs.
