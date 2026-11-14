# Contract documentation and OpenAPI task report

Completed for `plans/contract-crud-html-open.md`; no commit or deployment performed.

## Changed

- `docs/contracts-api.md`: API-first PDF + JSON draft creation, list/detail, patch, replacement PDF, draft-only deletion, send and cancellation; mandatory idempotency and owner isolation; explicit sender-as-party behavior; email/manual delivery and owner-only send receipts; immutable sent documents; mandatory personal-link email codes; final secure links and no attachments; HTML OPEN with explicit rejection; frontend-only language scope. Existing create-and-send, legacy JSON, invitation recovery and owner PDF download remain documented.
- `README.md`: concise lifecycle and security summary, recipient OTP configuration, final-link delivery and unchanged language/rendering scope; removed one duplicate configuration row.
- `src/hono/public-contracts-api.ts`: published CRUD routes and mandatory administrator/idempotency requirements, shared runtime draft/PATCH/send input schemas, public OTP inspect/request/verify endpoints and shared code validator; legacy contract endpoints retained.
- `src/hono/public-contracts-api.test.ts`: contract parity for runtime schemas, mutation authority/idempotency, both delivery responses, private links restricted to send receipts, no PDF bytes in read metadata, OTP response/cookie/rate-limit semantics and retained legacy endpoints.

## Verification

- PASS: `pnpm test src/hono/public-contracts-api.test.ts src/hono/api/agent-contract.test.ts` — 2 files, 9 tests.
- PASS: `pnpm exec biome check src/hono/public-contracts-api.ts src/hono/public-contracts-api.test.ts`.
- PASS: `pnpm types` after the final-delivery test fixture's literal-type issue was corrected by its owning agent.
- Full tests/lint/build, hosted verification, production release and actual mail delivery are outside this documentation subtask and remain for the parent agent's final validation.

Schema and route details were coordinated with the CRUD, OTP and final-delivery implementation agents. The independent CRUD reviewer identified a nonexistent upload-conflict code in prose; it was corrected to `CONTRACT_CHANGED`.

## Review follow-up

Documented the locked reservation's limit of 4,000 distinct private artifact keys per draft, including recorded failed/uncertain upload versions. A replacement beyond the limit returns `413 SOURCE_VERSION_LIMIT` before upload; recovery is draft deletion and recreation. Also made same-key recovery explicit after an uncertain creation/replacement response: a committed operation's stored success receipt replays without another upload or draft. Confirmed the code and threshold with the CRUD implementation agent. This follow-up changes prose only; OpenAPI already advertises `413`, so no broad test rerun was needed.
