# Contract CRUD implementation report

Implemented draft creation, owner-scoped reads, draft metadata/recipient/field editing, atomic PDF plus definition replacement, draft deletion, explicit email/manual send with personal links, and cancellation. Existing create-and-send requests keep their original responses and external-recipient restriction; new drafts accept an explicitly listed sender without creating any signature or field value.

## Evidence

| Acceptance criterion | Status | Evidence |
| --- | --- | --- |
| PDF plus JSON draft creation and exact idempotent replay | Verified | `src/hono/api/contracts-crud.test.ts`; real PGlite and Hono requests, unsigned sender assignment, no invitation during creation. |
| Owner isolation and draft-only mutation | Verified | Foreign read/edit/send/delete return 404; post-send edits/replacement/deletion return 409. |
| Metadata, recipients and field definitions edit atomically | Verified | Full merged definitions are checked against the current private PDF; unmatched definitions leave the stored contract unchanged. |
| PDF replacement preserves an immutable history | Verified | Versioned source rows and every reserved private locator remain in the artifact manifest; source, fields, recipients, definition and response receipt commit together. |
| Manual and email delivery | Verified | Manual activates links without invitation mail; email queues the durable invitation outbox and keeps links inactive until delivery confirmation. Links occur in the send receipt, not audit or general read responses. |
| Cancellation revokes links | Verified | Cancellation locks the envelope, changes status to expired, revokes signer tokens and cancels undelivered invitation jobs. OTP session validity follows token authority. |
| Safe draft artifact deletion and storage failure recovery | Verified | Deletion intent closes other mutations; all source, final and manifested keys are erased before deleted state. A pending upload blocks deletion. Failed erasure can be retried with a new key. |
| Upload races and uncertain database receipts | Verified | Owner/status races cannot install a replacement; uploaded uncommitted versions remain privately manifested until deletion. Lost committed save receipts preserve the live source and replay the successful receipt. Unknown database failures are fenced by envelope lock and reconcile to the stored response or a recorded 503, so abandoned commands do not permanently prevent deletion. |
| Existing failed legacy drafts remain recoverable | Verified | A legacy invitation failure leaves a draft that can be reviewed with PATCH and deliberately sent through the new lifecycle. |
| Bearer, browser CSRF and private call budget | Verified | Browser CSRF/replay regression; real hosted dispatcher and private storage gateway tests cover Bearer and browser owner/status races and upload receipt loss. Each such failure uses exactly 10 external calls, including its failure receipt. |
| PDF, field and artifact limits | Verified | Existing 2 MiB, 10-page and 20-field PDF policy retained. JSON oversize and too many fields return 413. Locked reservations refuse the 4001st distinct stored artifact with `SOURCE_VERSION_LIMIT` before uploading. Invalid PDFs are validated before reservation. |
| HTML remains unavailable | Verified | Multipart HTML returns `HTML_RENDERING_UNAVAILABLE`; unsupported JSON definition kinds are rejected. Shared bounded JSON reading explains that HTML rendering is unavailable. |
| Legacy placeholder signing regression | Verified | `contracts-placeholder-e2e.test.ts` now provides explicit token-bound email session fixtures and still completes a real flattened PDF. |
| Complete repository checks and deployment | Delegated | Root agent owns full suite, lint/build, independent review, Dev/Prod verification and release authorization. No commit or deployment performed by this task. |

TDD observations: initial CRUD routes returned 404; JSON limit regression returned 400 instead of 413; legacy draft PATCH returned 503; lost committed save receipt deleted the live source; late replacement race used 12 private calls; unbounded reservations accepted key 4001; unsupported `kind` was silently accepted; unknown save/reservation failures returned 500 and left pending commands. Each corresponding focused regression was observed failing, corrected, and rerun green.

The focused tests count private database RPCs and the actual three-step storage upload protocol. The gateway fixture also verifies batch deletion, exact receipt replay and no unexpected invitation delivery. `pnpm types` passes. Scoped Biome checks pass with a cognitive complexity warning in the shared CRUD HTTP dispatcher; no lint errors remain in these files.

If both an original database operation and its fenced reconciliation remain unavailable, the application cannot safely infer the outcome. The command remains pending for operator investigation; it is never expired automatically while an upload might still be active. Existing datasets already above the newly enforced 4000-key limit require operator-assisted erasure.

## Hosted deletion protocol follow-up

Hosted Dev initially returned generic `STORAGE_UNAVAILABLE` when deleting immediately after upload. Primary platform source (`apps/storage-gateway/src/runtime.ts` in the local ohmyho checkout) waits until the five-minute signed PUT lease plus the 30-second drain period before erasing. The installed runtime SDK 0.1.53 correctly reports pending `retryAt`. The two exact hosted fixtures were successfully deleted with fresh command keys after this window; temporary credentials were revoked.

The adapter now preserves the latest pending deadline in a typed error. The contracts API returns `503 STORAGE_DELETE_PENDING` with `retryAt`, `retryable: true`, and an absolute HTTP-date `Retry-After`, including identical idempotent replay headers. A fresh command after completed erasure returns 200. Deletion intent and private artifact locators remain durable throughout the wait. True gateway failures still fail; only the scoped SDK `object_not_found` result is treated as already absent, because no storage reservation or signed upload capability exists for that logical key and the application already fenced outstanding uploads. This also permits erasing application manifests from failed operations that never reached storage reservation. Existing deletion controls use the same fenced adapter.

Three real SDK/application protocol regressions were observed failing before the correction (missing pending deadline, permanent failure for a never-reserved key, generic API error), then passed. The OpenAPI parity regression likewise failed before documenting the optional fields and header. The real hosted dispatcher fixture checks the ten-call ceiling for the pending and completed deletion requests. No migrations or schedules were added; release verification belongs to the root agent.
