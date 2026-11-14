# Contract CRUD, email verification and final PDF integration

Status: VERIFIED locally on 2026-11-14.

## Test boundary

`src/omh/contracts-crud-otp-e2e.test.ts` runs four scenarios through `dispatchHostedRequest`, including its administrator authorization gate, exact forwarded-request credential cache, Hono routes, real OMH Drizzle driver, all additive OMH migrations in PGlite, and the real PDF preparation/final renderer. `contracts-crud-otp-test-fixture.ts` implements only the external private storage and mail gateways. Uploads use the actual reserve → signed PUT → complete protocol; downloads use the actual framed batch protocol.

The fixture captures only locally generated six-digit test codes from the private mail boundary and verifies them through the public OTP endpoint. Codes, sessions, API credentials, personal links and document content are not retained in this report or test output.

## Acceptance evidence

| Criterion | Result | Evidence |
| --- | --- | --- |
| Draft create/list/detail, edit and PDF replacement | Verified | Multipart PDF plus definition; source versions 1 and 2; final text contains replacement content and both submitted names. |
| Manual and API email delivery return personal links | Verified | Manual sends no invitation; email returns 202 and queued invitation; sender appears only when explicitly listed as a party. |
| Explicit sender signing | Verified | No field values exist at send; recipient signs first; owner signs through a separate email-verified session before completion. |
| OTP protects existing links and document paths | Verified | Even persisted `verified_at` cannot bypass the session; token-only detail/source/completion/final requests fail; another recipient's cookie fails. |
| Final PDF and safe final access | Verified | Real PDF has an audit page, current renderer metadata and both signatures; owner-isolated API access, session-authorized recipient access and rejection of a bare final-document UUID. |
| Final delivery to all unique parties and creator | Verified | Two durable version-bound final intents for explicit creator-as-party plus recipient; protected creator history path and OTP-protected recipient path; dispatcher sends each once without attachments. |
| Immutable post-send document | Verified | PATCH, PDF replacement and DELETE return 409 after send; source versions remain unchanged. |
| Owner isolation | Verified | A second valid administrator's GET/PATCH/PUT/send/cancel/delete return 404; final PDF also returns 404. |
| Draft deletion | Verified | Draft deletion removes private file, hides detail and blocks send; exact retry replays receipt. |
| HTML stays open | Verified | HTML multipart upload returns 400 `HTML_RENDERING_UNAVAILABLE`. |
| Idempotent retries and uncertain mail receipt | Verified | Identical create/send/delete/retry-invitations replay; changed create reuse conflicts; accepted-but-lost invitation receipt retries with the same gateway key and produces one message. Terminal repeated signing returns 409 and creates no second final artifact or intent. |
| Browser session plus CSRF | Verified | Separate browser-authorized create/read/PATCH/PDF replacement/send flows for manual and email delivery. |

## Hosted request budget

The fixture counts each actual database binding call and external gateway fetch per hosted request. Every request asserts a maximum of 10 total subrequests. This includes administrator dispatch authorization and the actual private storage SDK protocol, rather than an estimated R2 operation cost.

| Successful operation | Database | Files | Mail | Total |
| --- | ---: | ---: | ---: | ---: |
| Create draft, Bearer or browser | 6 | 3 | 0 | 9 |
| PATCH draft, Bearer or browser | 6 | 1 | 0 | 7 |
| Replace PDF, Bearer or browser | 7 | 3 | 0 | 10 |
| Send manual or email, Bearer or browser | 6 | 0 | 0 | 6 |
| Request OTP | 3 | 0 | 1 | 4 |
| Verify OTP | 4 | 0 | 0 | 4 |
| Read signer source | 3 | 1 | 0 | 4 |
| First recipient signs, configured progress mail | 2 | 0 | 1 | 3 |
| Final recipient signs and stores final PDF | 4 | 4 | 0 | 8 |
| Owner final PDF, Bearer | 5 | 1 | 0 | 6 |
| Signer final PDF | 4 | 1 | 0 | 5 |
| Completed-document PDF | 2 | 1 | 0 | 3 |
| Retry uncertain invitation | 7 | 0 | 0 | 7 |
| Delete draft | 7 | 1 | 0 | 8 |

PDF replacement reaches the platform limit exactly. Future request work on that route must preserve this regression assertion.

## Verification commands

- RED: the initial three scenarios failed with draft-route 404 before implementation was mounted.
- GREEN: `pnpm exec vitest run src/omh/contracts-crud-otp-e2e.test.ts` — 4 tests passed.
- `pnpm types` — passed.
- `pnpm exec biome check --write src/omh/contracts-crud-otp-e2e.test.ts src/omh/contracts-crud-otp-test-fixture.ts` — passed.

Failing criteria: none in this task's integrated scope. Unverified here: complete repository suite/lint/build, independent review and actual Dev/Prod gateway behavior; these are owned by the parent release workflow. No production source was edited by this task.
