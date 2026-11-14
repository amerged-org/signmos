# Signer email-code UI task report

## Result

Personal signing links now show an explicit **send code** action with the masked destination. Sending reveals one six-digit field, a submit action, validity countdown and resend cooldown. Successful verification refreshes the signing document without an extra navigation step. Existing `/signing-verifications/:token` URLs use the same screen and continue to `/signing/:token` only after code verification.

Completed-document links recover from `PARTNER_VERIFICATION_REQUIRED` through the same code form and refresh the completed view after verification, restoring the final PDF download action. No account or password is introduced. Contract contents and field values are unchanged; language changes affect frontend copy only.

## Changed files

- `src/components/signing/signing-verification-page.tsx`: TanStack Query inspection/request/verification, TanStack Form code validation, focus, expiry/cooldown and safe localized errors.
- `src/components/signing/signing-verification-page.test.tsx`: request/verify, six-digit validation, error recovery, cooldown/expiry and language preservation regressions.
- `src/components/signing/signing-copy.ts`: DE/EN/NL code-flow copy and exact backend error mapping.
- `src/components/signing/signer-page.tsx` and adjacent test: direct code entry screen for a blocked personal link.
- `src/components/completed-documents/completed-document-page.tsx` and adjacent test: code recovery before completed-document metadata/download access; Query owns loading/refetch state.

## Endpoint agreement

- `GET /api/signing/verifications/:token` inspects the original personal signer token without granting access or sending mail; returns `data.emailHint`.
- `POST /api/signing/:token/email-code/request` with `{}` returns masked destination, expiry seconds and retry seconds.
- `POST /api/signing/:token/email-code/verify` with `{code}` sets server-side browser authority and returns `{verified:true,signingUrl}`.
- `PARTNER_VERIFICATION_REQUIRED` includes `emailHint`; UI sends no language/document/field changes with either OTP operation.
- Localized error codes: `INVALID_EMAIL_CODE`, `EMAIL_CODE_RATE_LIMITED`, `EMAIL_DELIVERY_UNAVAILABLE`, `EMAIL_VERIFICATION_UNAVAILABLE`, plus existing invalid/expired/deleted-link errors. The cooldown respects `Retry-After`.

## Evidence

Red tests were observed before implementation:

1. Core verification tests failed because the old GET flow immediately granted access and showed no masked destination or send-code action (2 failing tests).
2. Personal signer-link test failed because the old UI showed a separate verification link instead of the send-code screen (1 failing test).
3. Exact OTP error tests failed on generic error copy before the mappings were added (4 failing tests).
4. Completed-link recovery test failed because the old page only displayed the generic unavailable alert (1 failing test).

Green verification:

```text
pnpm test src/components/signing src/components/completed-documents src/tests/language-signing-integration.test.tsx src/components/history/recovered-signer-accessibility.test.tsx
Test Files 9 passed (9)
Tests 39 passed (39)
```

All seven changed UI source/test files pass targeted `pnpm exec biome check` with no errors or warnings. `pnpm types` reported no errors in this task's files; its latest run was blocked by concurrent integration-test work (`otherOwner` unused and a `Response | Promise<Response>` return in the contract CRUD/OTP fixture), reported to the parent agent for the owner to fix.

| Acceptance criterion | Status | Evidence |
| --- | --- | --- |
| Explicit request before sending email or exposing a code form | Verified | Component request regression, one inspection call before click |
| Six-digit code required before continue | Verified | Invalid-length submission makes no verify request; valid code submits the exact payload |
| Masked destination, pending state, expiry and resend | Verified | Component tests; fake-clock cooldown/expiry test |
| Safe localized OTP and link errors | Verified | Invalid/expired/mail/config/rate-limit tests; raw server messages absent |
| DE/EN/NL frontend language selection preserves typed code | Verified | Language-switch component regression |
| Existing contract fields and signing behavior preserved | Verified | Existing signer, field, signature and language-integration regressions |
| Completed personal links recover to final PDF action after OTP | Verified | Completed-page interaction test |
| Whole-repository types/tests/lint/build | Unverified in this subtask | Parent owns final aggregate verification; transient integration type errors reported |
| Browser visual QA and Dev/Prod verification | Unverified in this subtask | No deployment or browser environment changes performed |

No commit or deployment performed.

## Review follow-up: expired session during a mutation

The independent review identified that an already-open signing form only recovered from a failed initial GET. A later completion, decline or change request returning `403 PARTNER_VERIFICATION_REQUIRED` previously left the user with an error message and no code flow.

All three mutations now share the same email-proof recovery handler. The existing signing view stays mounted in a hidden React Activity while the code screen is visible, retaining typed contract values, the signature and comments. Successful OTP verification refreshes signer authority/state. The failed action is retried only when the user explicitly submits it again. Other error responses retain their existing handling.

TDD evidence: `src/components/signing/signer-page-email-recovery.test.tsx` initially failed all three cases because no send-code action appeared after the mutation response. All three are now green and check preserved inputs, refreshed signer access, no automatic mutation retry and an identical payload on the explicit retry.

```text
pnpm test src/components/signing src/components/completed-documents src/tests/language-signing-integration.test.tsx src/components/history/recovered-signer-accessibility.test.tsx
Test Files 10 passed (10)
Tests 42 passed (42)
```

Both follow-up files pass targeted Biome checks without warnings. The signer source remains below the repository's 500-line limit (428 lines). No commit or deployment performed.

The follow-up `pnpm types` run also passed after the concurrent integration changes settled.

## Release-test follow-up: signature mode readiness

The aggregate release test run exposed one timing-sensitive assertion in `signer-page.test.tsx`: immediately after selecting drawn mode it synchronously looked up the signature pad. The actual signature implementation uses an inline SVG and TanStack Form's external-store subscription; there is no lazy signature canvas import. The test now waits for the drawn input to render and for the typed input to return before interacting with it. Its saved-profile, remembered-signature and exact submitted-payload assertions remain in place. No production code changed for this follow-up.

Validation: eight independent runs of the signer page, mutation recovery and signature form suites, randomized with seeds 101–108 and retries disabled, all passed: 3 files / 19 tests per run (152 test executions). `pnpm types` and targeted Biome also passed. The parent owns the subsequent full release-suite rerun.
