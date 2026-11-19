# Independent OTP and final-delivery review

Reviewed on 2026-11-14 against base `7c6236175b66c0f33f858f6ae7ebf2592b0afc08`, including tracked and untracked worktree changes. This review did not modify implementation files.

## Findings

1. **P2 — Persist the complete final-mail payload across retries.** Initially, `src/omh/final-delivery-outbox.ts:86` rebuilt subject/text/HTML from the running release while reusing `sign.final.${job.id}`. A branding/template deployment after an uncertain first attempt changed the payload for an existing provider idempotency key. The new regression that changes the branded renderer between attempts reproduced the problem. **Resolved and independently verified:** `src/omh/final-delivery-outbox.ts:78` now stores subject, text, and HTML on the first claim together with sender/reply-to/access URL; subsequent sends use the stored fields at line 108.

2. **P2 — Recover from mutation-time loss of email proof.** In the initially reviewed `src/components/signing/signer-page.tsx:101`, completion failures stored `PARTNER_VERIFICATION_REQUIRED` only in `completionError`, while the verification screen depended on the separate `error` state. Expiring the eight-hour session, or verifying another personal link and replacing the shared cookie, left an already-open form showing a verification message with no code controls. Decline and change-request mutations similarly showed generic failure without recovery. **Resolved and independently verified:** the shared recovery handler at `src/components/signing/signer-page.tsx:91` routes all three authorization failures to the code flow. The form remains mounted through React Activity, preserving entered contract/signature/comment values; verification refreshes the session and an explicit retry sends the same payload. New regressions cover each mutation.

No unresolved blocking finding remains in this review scope.

## Verified design and boundaries

- Personal signing reads, source/final PDF paths, field updates, completion, decline, and change requests require a token-scoped email session. Historical `verified_at` alone is insufficient for those HTTP paths.
- `/api/final-documents/:token/pdf` explicitly passes an email-session hash, including an empty value when no cookie exists, so the internal bare-final-ID lookup branch does not grant HTTP authority. The document view endpoint also checks the scoped signer session first.
- OTPs use unbiased CSPRNG six-digit generation, domain-separated HMAC-SHA256 with required `SIGN_OTP_SECRET`, a ten-minute challenge, five atomic attempts, a sixty-second normalized-recipient cooldown, and recipient/IP hourly caps. Only digests persist. Redemption consumes a challenge once.
- Session checks bind token, envelope, recipient, normalized current email, and expiry. Revoked tokens and deletion markers are denied. Source and final PDF responses recheck authorization after storage reads.
- Same-origin mutation checks and a Strict, Secure, HttpOnly host-only session cookie protect the browser flow. `Cache-Control: no-store` and `Referrer-Policy: no-referrer` cover personal API responses.
- The production entry `src/start.tsx` calls `dispatchHostedRequest`; `src/omh/auth-gate.ts:100` strips `x-now` before returning public signing/final-document requests. Test-clock headers in raw Hono tests are therefore not a production bypass. An initial concern about that header was retracted after tracing this boundary.
- Final outbox intent is committed with final metadata/status after successful private-file upload, deduplicated by final document/hash/normalized email, and addressed to parties plus creator. Notifications carry protected links without attachments.
- Final delivery claims revalidate completion, deletion state, recipient completion, and current final SHA. Recovery retains its idempotency key and conservatively moves attempts older than twenty-two hours to manual review. The scheduler shares three jobs across invitation/final delivery work; the focused test measures no more than ten calls.
- Frontend language changes do not translate outgoing email or PDF content. Reviewed new source files remain below 500 lines and introduce no `any` types.

## Verification

Independent command:

```sh
pnpm exec vitest run src/hono/api/signer-email-otp.test.ts src/omh/final-delivery-outbox.test.ts src/db/envelope/final-delivery.test.ts src/components/signing/signing-verification-page.test.tsx src/components/signing/signer-page.test.tsx src/components/signing/signer-page-email-recovery.test.tsx src/components/completed-documents/completed-document-page.test.tsx
```

Initial result: **43 passed, 1 failed** across six files. The single failure was the newly added changed-branding retry regression described in finding 1, observed while its implementation fix was in progress.

Final independent rerun: **49 tests passed across 7 files**, including both resolved findings and the alternating scheduler-priority regressions. Command completed successfully in 2.65 seconds.

Full types/lint/build/full-suite checks and live Dev/Prod verification belong to the coordinating implementation run; this scoped review does not claim them.

## Operational follow-up

The initially reviewed scheduler gave invitations all three slots before considering final mail, permitting sustained invitation backlog to starve final notices. The outbox owner addressed this review note: `src/ohmyhost/worker.ts:13` alternates priority by five-minute scheduled-time bucket, then gives remaining slots to the other queue. Independent tests cover two busy queues across consecutive ticks and final-first remainder allocation while retaining the three-job/ten-call bounds.
