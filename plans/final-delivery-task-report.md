# Final PDF delivery task report

Status: implemented locally; no commit or deployment performed.

## Behavior

The successful final artifact transaction now records one durable delivery intent per normalized participant/creator email and final SHA-256 version. Creator-as-party addresses are deduplicated and receive `/my-documents/{envelopeId}`; other parties receive `/completed-documents/{signerToken}`. Creator access uses the existing verified-email history identity; signer final access is OTP/session-protected by the coordinated signer-email implementation. The first intent extends active signer links to at least seven days from artifact commit.

Final PDF repair also batches the repaired artifact locator and its version's delivery intents atomically, after the private upload. This prevents replacing the final SHA-256 from stranding the old version's pending messages.

`contract_final_delivery_outbox` is introduced by additive migration `20261114120000_contract_final_delivery_outbox.sql`. Its unique `(final_document_id, final_sha256, to_email)` constraint prevents duplicate intents. It stores the personal access path and atomically snapshots sender, reply address, absolute access URL, subject, plain text and complete branded HTML on the first claim before any mail leaves. Retries send only these persisted canonical fields, so a later deployment can change branding/copy without changing an already attempted provider payload. Mail contains the branded amerged layout and protected access link, without attachments.

The scheduled worker shares three job slots between invitations and final delivery. It alternates first priority using the scheduled timestamp’s five-minute bucket parity, then gives remaining slots to the other queue. Both busy queues therefore make progress across consecutive scheduled ticks rather than letting a sustained invitation backlog starve final delivery. A final job uses one claim, one gateway call and one receipt transaction. The at most one empty primary-queue claim keeps the successful mixed/only-final schedule within ten private calls. No network request spans a database transaction. Receipt-response loss leaves an already delivered job delivered; a failed uncommitted receipt is recovered through the stale lease using the same `sign.final.{job.id}` key. Sending/uncertain final jobs become retryable after ten minutes, retain the original first-attempt timestamp, and stop at manual review after 22 hours. Claiming excludes cancellation, deletion intent, incomplete parties and replaced final SHA-256 values.

The previous synchronous sender success notice no longer runs before last-signature artifact completion. Final completion relies on the durable outbox. Partial-signing progress notices run after the durable signature write; mail failure cannot reject an accepted signature.

## TDD evidence

- RED: finalization returned a final artifact but no participant/creator outbox intents; GREEN: normalized dedupe, safe personal paths and seven-day link window pass against PGlite.
- RED: scheduler sent no final messages and left final jobs queued; GREEN: branded link-only delivery, mixed invitation/final budget, stable retry key/payload across configuration changes, stale-window/manual-review behavior and lost-receipt recovery pass.
- RED: failed final upload still sent a synchronous sender success email; GREEN: zero mail before final upload completion.
- RED: final PDF repair committed a new version without delivery intents; GREEN: artifact update and new-version intents commit in one transaction.
- Independent review follow-up RED: changing the branded renderer between an uncertain attempt and retry changed HTML under the same provider key. GREEN: the first atomic claim persists the entire subject/text/HTML payload, and retry remains byte-for-byte identical after both renderer and sender/origin/reply configuration changes. The regression asserts persisted payload fields equal the original gateway payload.
- Independent review follow-up RED: six busy invitation jobs monopolized two consecutive ticks and left every final notification queued. GREEN: alternating primary priority delivers three jobs from each busy queue across consecutive five-minute ticks, and a short final queue gives only its two remaining slots to invitations within ten calls.

## Acceptance evidence

| Criterion | Status | Evidence |
| --- | --- | --- |
| Final artifact readiness before intent/delivery | Verified | `src/db/envelope/final-delivery.test.ts`; failed upload leaves no intents; repair queues only committed SHA-256 |
| Unique parties plus creator, normalized dedupe | Verified | PGlite recipient/creator overlap and differently cased duplicate party fixture |
| Personal protected URLs, no PDF attachment | Verified locally | Expected creator/history and signer/OTP paths; gateway payload assertions; route protection owned/tested by OTP task |
| Durable exactly-one intent per final version/address | Verified | SQL unique constraint; repeated finalization retains two intents; repaired version enqueues new intents |
| Retry stable provider key and complete canonical payload | Verified | Uncertain delivery, renderer/configuration-change replay, persisted body assertions and committed-lost-receipt tests |
| Bounded worker subrequests/no transactional network | Verified | Real private DB adapter/PGlite plus gateway counter: max three jobs and at most ten calls in mixed, only-final, consecutive busy queues and final-first remainder scenarios |
| Existing signing path budget | Verified | `signing-postgres.test.ts`: completion nine calls after removing precommit mail; repaired final download ten calls with OTP integration |
| Migration rollout, real mailbox delivery and deployed CPU | Unverified | No migration/deployment/live delivery authorized in this subtask; CPU is not inferred from tests |

## Validation

- Eight focused suites, **50 tests passed**: final-delivery, finalization, signing-completion, signing-postgres, final-delivery-outbox, contracts-outbox, scheduled-worker, agent-partner-completion.
- `pnpm types`: passed after concurrent task fixes.
- Focused Biome checks: passed without warnings on owned implementation/test files.
- Changed production files remain below 500 lines; finalization is 498 lines.
- Full repository tests, lint/build, package checks and deployment validation are coordinated by the parent task.

## Files

- `src/db/final-delivery/{index,table,test-db}.ts`
- `src/omh/final-delivery-outbox.ts` and adjacent tests
- `src/db/envelope/finalization.ts` and final-delivery regression tests
- `src/db/envelope/signing-completion.ts` and notification regressions
- `src/omh/contracts-outbox.ts`, `src/ohmyhost/worker.ts`, shared regression adapters/tests
- `src/db/schema.ts`, additive migration above

No commits, production writes, external messages or deployments were performed by this task.
