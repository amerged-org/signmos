# Hosted Dev contract CRUD verification

Status: VERIFIED with a delayed private-file deletion retry.

Executed on 2026-11-14 against https://dev-quick-crabs-warn.check.omh.st using CLI profile `amerged`.
Project: `01M5EW9QMM7HCMWB5HYZ6TK8C4`; isolated Dev: `01M5EW9QMM7HCMWB5HYZ6TK8C9`.
Deployment: `01M7D2JM5G535M3V9B8WSETF3W`.
Commit: `6c51433ee2a67548d14aa2d023198e55cb928b37`.
Artifact: `9ce633e1e3705c9704ff3a0ae9cc910b4b8e6d301e3cf07711f4fa952279acd3`.

The harness obtained the protected Dev share link privately and kept its cookies and temporary application Bearer credentials in memory. Only application token hashes were seeded. Two synthetic contracts were created for manual delivery; no invitation, OTP or completion email was requested. All database writes were restricted to those exact fixture IDs and temporary credentials. No real contract was read or changed, and Prod was untouched.

| Check | Observed result |
| --- | --- |
| Create PDF plus JSON draft | 201 |
| Read draft | 200 |
| PATCH draft title | 200 |
| Replace PDF and field definitions | 200 |
| Send manually | 200; two personal links for explicitly listed parties |
| Creator signing behavior | Creator explicitly listed as a party; no automatic signature or field value |
| Personal signing URL origin | Every returned URL used the isolated Dev origin |
| Token-only signer detail/source/final access | 403 on each route |
| Token-only completion | 403 |
| Post-send PATCH, PDF replacement and DELETE | 409 on each route |
| Source immutability | Stored source versions and hashes unchanged after blocked mutations |
| Manual delivery | No invitation outbox rows and no field values |
| Cancel | 200; persisted expired state |
| Delete unused draft immediately after upload | Initially 503 `STORAGE_UNAVAILABLE` |
| Delete both exact synthetic fixtures after capability expiry | Fresh-key API DELETE 200 for both; persisted deleted state and zero field values |
| Temporary credential cleanup | Original smoke credential and follow-up cleanup credential revoked; active-count checks zero |
| Dev health | GET `/api/health/live` 200, status `ok` |
| Public OpenAPI | GET `/openapi.json` 200; all 10 checked CRUD and OTP operations present |

Private storage initially refused deletion while signed upload capabilities could still write. Fresh idempotency keys succeeded after the capability and drain window; successful API deletion receipts confirmed erasure of both fixtures' private artifacts. The last synthetic upload was at 13:10:24 UTC; follow-up cleanup ran after the expiry window. No additional contracts were created during diagnosis or cleanup.

The initial deployment returned a generic 503 during the temporary erasure window. The later typed error correction is verified separately below.

No share URL, cookies, API credential, token hash, recipient signing link or PDF content is retained in this evidence. The ephemeral smoke and cleanup scripts live outside Git under `/tmp`.

## Typed pending-delete verification

Status: VERIFIED.

Fixed Dev commit: `7259e423c4f6d901e29f4dacc79c85302382b71d`.
Deployment: `01M7D3G4DQ18G0BD0H9QXB9SKH`.
Artifact: `4dbd38cebbb2e5fe23c7571632c740e92260e8b2ab48cfe097e22a1d47fe27ee`.

- Synthetic draft staged at 2026-11-14T13:20:38.328Z.
- New Dev readiness flag received at 2026-11-14T13:25:43.719Z for commit 7259e423c4f6d901e29f4dacc79c85302382b71d.
- First draft capability expired before new Dev was tested; its deletion returned 200.
- Synthetic draft staged at 2026-11-14T13:26:24.724Z.
- New Dev DELETE returned 503 STORAGE_DELETE_PENDING, `retryable: true`, retryAt 2026-11-14T13:31:53.864Z and matching HTTP-date Retry-After Sat, 14 Nov 2026 13:31:54 GMT.
- Same Idempotency-Key replay preserved status, complete body and Retry-After exactly.
- Fresh-key DELETE after retryAt returned 200 at 2026-11-14T13:32:03.696Z; successful receipt confirms private artifact erasure and persisted deleted state.
- All recent taskfixture API credentials are revoked; aggregate active count zero.

Typed pending semantics, exact replay, retry scheduling and final erasure were verified against actual protected Dev.
