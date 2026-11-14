# Independent contract CRUD review

Reviewed 2026-11-14 against base `7c6236175b66c0f33f858f6ae7ebf2592b0afc08` and the working tree, including untracked CRUD modules. This review changes only this report. No commit or deployment was made.

## Scope and evidence

Read `AGENTS.md`, `ARCHITECTURE.md`, `docs/AGENT_GUIDE.md`, `plans/contract-crud-html-open.md`, the CRUD HTTP adapter, draft/schema/store/lifecycle modules, compatibility create-and-send path, invitation outbox, hosted authentication/storage adapters, and public OpenAPI/docs. Also inspected the shared command authority and relevant signing boundaries.

Independent focused verification:

```sh
pnpm exec vitest run src/hono/api/contracts-crud.test.ts src/hono/api/contracts.test.ts src/omh/contracts-create.test.ts src/omh/contracts-postgres.test.ts src/omh/contracts-outbox.test.ts src/omh/contracts-crud-otp-e2e.test.ts src/hono/public-contracts-api.test.ts
```

Result at initial review checkpoint: **7 files, 48 tests passed**. Additional regressions were added concurrently by the implementation owner in response to review; the final verification checkpoint below records their disposition.

## Findings and disposition

### R1 — P1: a failed final-save transaction could permanently block draft erasure (fixed and independently rechecked)

Evidence at the initial review checkpoint (before the reconciliation fix): `src/omh/contracts-drafts.ts:65` reserved a replacement by associating its command with the document before uploading. `src/omh/contracts-draft-store.ts:130` converts only division-by-zero guard failures into `ContractError`; other database failures propagated. The original `src/hono/api/contracts-crud.ts:153` completed only `ContractError` failures, so a rolled-back final save with SQLSTATE `40001` left the upload command `pending`. `src/omh/contracts-lifecycle.ts:176` rejected deletion while *any* such pending upload command existed, with no expiry/recovery predicate. The shared `src/db/agentic-access/command-authority.ts:116` always returns `in_progress` for an unfinished receipt and provides no takeover or lease.

A separate temporary PGlite test, outside the repository, injected a `40001` result before the final source-save transaction. Observed sequence: replacement returned 500; exact retry returned 409; a replacement with a new key succeeded; deletion with a new key still returned 409; the original upload command remained `pending`. This is a reproduced availability/erasure defect, not a hypothetical concurrency concern.

The final implementation routes unexpected post-claim errors to `reconcileContractCommand` (`src/omh/contracts-command.ts:76`). Its single database batch locks the associated envelope, completes only a still-pending command with a stable 503 failure, and reads the actual completed receipt. A committed success remains intact; an original save that starts after reconciliation fails its pending-command guard. Uploaded files remain manifested for erasure. Independent rerun of the separate reproduction now observes 503 -> exact 503 replay -> new-key replacement 200 -> deletion 200, with the original command completed. Hosted regressions separately cover a source-save rollback and a committed initial reservation whose receipt was lost. Complete database unavailability during reconciliation or abrupt worker termination was not runtime-tested; this report does not claim recovery from every process crash.

### R2 — P1: lost save receipt deleted a committed active PDF (fixed during review)

The original `uploadAndSave` catch deleted its unique source key after every save exception. A successful database commit followed by a lost RPC receipt therefore erased the active PDF while exact retries replayed the stored 201/200 success. The implementation owner added a real transaction-commit/lost-receipt regression that first reproduced the missing file, then changed cleanup to retain uploaded, manifested files on uncertain database outcomes. Exact success replay and manual send are covered. Independent final rerun passes, including immediate replay of the successful receipt from reconciliation.

### R3 — P1: replacement race/error path exceeded the hosted ten-subrequest ceiling (fixed and independently rechecked)

The initial successful replacement used ten actual calls: three Bearer-auth database calls, command claim, snapshot, reservation, three private upload calls, and final save. A late guard failure then added private deletion and failed-command receipt writes, reaching twelve. The earlier unit race test counted database calls only, so it did not detect this defect.

The implementation owner combined locked snapshot and artifact reservation into one database RPC and retains uploaded artifacts in their durable manifest until eventual deletion. Real private-storage protocol regressions now exercise late owner/status changes and a lost upload-complete receipt for both Bearer and browser authentication, including stable error replay and eventual erasure. Independent final rerun confirms these failure paths are exactly ten calls and subsequent deletion removes the retained files.

### R4 — P2: unbounded source versions could make a draft impossible to erase (fixed and independently rechecked)

`src/omh/contracts-lifecycle.ts:178` inventories 4001 distinct artifact keys and refuses erasure when more than 4000 exist. Originally, valid replacements could create an unlimited number of manifests, so an otherwise valid draft with 4001 keys could never be deleted through this API. The owner added a count of the distinct manifest/source/final key union to the locked reservation and rejects the next key with `413 SOURCE_VERSION_LIMIT` at 4000. This prevents newly created API drafts from exceeding the erasure batch. The documented limit includes retained uncertain uploads. Independent final rerun confirms the 4001st reservation is rejected before upload without adding a manifest entry. Deterministic PDF validation now also runs before reservation.

### R5 — P2: existing legacy draft could not be reviewed or sent (fixed during review)

The first snapshot implementation required a `contract.definition` audit row that the compatibility create-and-send implementation never wrote. An existing coordinate-based draft left after uncertain invitation delivery consequently returned 503 for PATCH/send. The owner added exact reconstruction from the single existing recipient, source metadata, stored coordinate fields and title. The added regression now passes through legacy failure -> PATCH -> manual send. Unchanged multipart invitation recovery remains covered separately.

### R6 — P3: runtime accepted unsupported `kind` values that OpenAPI rejected (fixed during review)

`DraftContractJsonSchema` allows only optional literal `kind: "placeholder"`; the initial runtime parser removed any supplied `kind` and silently normalized it. The parser now rejects other values explicitly, including HTML, and has a regression. No HTML rendering was introduced.

## Acceptance review

| Criterion | Review result |
| --- | --- |
| Owner isolation | Verified through normalized owner predicates, locked mutation guards, and second-owner HTTP regressions. Unknown/non-owned/deleted IDs use the same 404 surface. |
| Idempotency on all contract mutations | Operation/payload/key claims, exact send-link replay, and locked failed-command reconciliation verified; R1 regression now passes. |
| Browser CSRF and Bearer authentication | Shared administrator resolver enforces the allowlist; cookie mutations require exact origin and session-derived CSRF. Hosted wrapper reuses only the exact request-scoped verified identity. |
| Draft-only PATCH, replacement and deletion | Guarded under an envelope lock; sent/queued/terminal documents reject draft modification. Concurrent source/definition changes are detected. |
| Private immutable source versions and cleanup | Unique keys and a durable manifest prevent one replacement from erasing another; lost receipts, save rollback, error-path budgets and eventual deletion regressions pass. |
| Manual/email delivery and private links | Manual sends no invitation jobs; email uses the durable outbox and initially revoked tokens. Personal signing links appear in authenticated send receipts and exact replays, not list/detail. |
| Explicit creator-as-party, no automatic signature | Draft party definitions can include the creator; no draft/create/send operation inserts a completed field value or fabricates consent. Compatibility behavior remains explicit and documented. |
| Source fixed on send | New CRUD guards freeze PDF/recipients/fields once sent or queued; no new renderer or overwrite-in-place source path was added. |
| PDF and recipient bounds | Shared 2 MiB, 10-page, 20-field policy retained; placeholder recipients are bounded to three, unique emails/indices, and matched fields. |
| HTML remains OPEN | Explicit rejection and user-facing explanation; no external renderer or third-party contract processing added. |
| Runtime/OpenAPI/docs parity | CRUD methods, delivery modes, schemas, status codes, lifecycle errors, signer OTP and private completion links are described. R6 was corrected. |
| Source under 500 lines / no `any` | New and changed production CRUD modules are below 500 lines and introduce no `any`. Existing oversized legacy test files are outside this source-file finding. |

## Final verification checkpoint

**No outstanding reproduced finding remains in the reviewed scope.**

- Original seven focused suites rerun after the final reconciliation change: **7 files, 48 tests passed**.
- Additional `contracts-draft-gateway-budget.test.ts` and `contracts-draft-limits.test.ts`: **2 files, 6 tests passed**.
- Independent temporary regression for the previously permanent pending reservation: **1 test passed**, now asserting stable 503 replay, successful later replacement and successful erasure.
- Scoped Biome check of the six new/changed production CRUD modules: no errors, one existing-in-this-implementation cognitive-complexity warning for the central HTTP handler (score 68 versus configured advisory threshold 15). This is a maintainability observation, not a failing acceptance criterion.
- Production CRUD modules remain below 500 lines and contain no `any`.

Full repository types, complete test suite, lint/build and actual hosted Dev/Prod verification are owned by the parent release workflow and are not claimed by this read-only review. The hosted-budget regressions use the actual private storage SDK protocol against a controlled gateway fixture; they do not substitute for a deployed platform smoke test.
