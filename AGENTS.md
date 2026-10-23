> amerged Sign fork: production hosting is ohmyho.st, not an upstream Wrangler deployment. Follow `plans/amerged-sign-omh-prd.md`, `ohmyhost.yaml` and `docs/contracts-api.md`. The global request middleware (`src/omh/hosted-middleware.ts`, registered in `src/start.tsx`) wraps requests with lazy `withDatabase(env, callback)` and administrator authorization; the private OMH Drizzle driver replaces Neon HTTP. Files use the private OMH runtime client; transactional mail uses the OMH runtime mail client over the global `fetch`, not the private mail binding (`src/omh/mail.ts`, `ARCHITECTURE.md`). The upstream Wrangler environments, direct-deployment script and historical release evidence are retained reference material and must not be used to publish this fork. Never deploy to the upstream signmos.com hostname.

# signmos Agent Map

Signmos is a lightweight e-signature workflow on TanStack Start, Hono, Cloudflare Workers, Neon Postgres, Drizzle, and Cloudflare R2.

Use this file as the always-loaded map. Load deeper docs only when the task touches that area.

## Start Here

| Need | Read |
| --- | --- |
| Product scope, lifecycle contract, validation checklist | `plans/simple-esignature-prd.md` plus the relevant `plans/*-prd.md` amendment |
| Physical code map, boundaries, invariants | `ARCHITECTURE.md` |
| Agent workflow and coding rules from `.claude/rules` | `docs/AGENT_GUIDE.md` |
| Manual setup, API examples, smoke flow | `README.md` |
| Implementation plans, issue drafts, and release evidence | `plans/`, `plans/issues/`, `plans/evidence/` |
| Compact LLM index | `llms.txt` |

## Current Product Surface

- Draft envelope creation, one source PDF upload under 10 MB, recipients, signature/date fields, send, signer links, signer completion/decline, final PDF status/download.
- `/` is an unselected four-choice chooser for self-signing, signing with another person, passwordless My Documents access, or Agentic mode.
- `/my-documents` is the verified-email worklist for retained creator/signer documents, including search, filters, paging, resume/sign/review, final PDF download, and creator controls.
- An active My Documents session can start a new self-sign or two-party draft without repeating email verification.
- `/agentic-console` uses a separate short email-verified management session to create/list/revoke up to five named personal tokens; raw secrets are displayed once and never persisted.
- `/api/v1` is the stable role-authorized Bearer document API. `/agent.md` is its public operating guide and `/openapi.json` is its runtime-parity machine contract; every mutation requires `Idempotency-Key`.
- `/manual-signing-smoke` is the local browser smoke path for create -> prepare -> send -> sign -> final PDF.
- `/envelope-fields` is a field placement/review screen, not a full envelope dashboard.
- Resend delivers transactional email when configured; development/test flows may expose restricted fallback links.

## Issue Implementation Workflow

1. Fetch the live issue before implementing: `gh issue view <number> --json number,title,body,state,labels,url`.
2. Read `plans/simple-esignature-prd.md`, the relevant feature PRD/plan under `plans/`, and the matching local file in `plans/issues/` when present.
3. Load the local TDD skill for the implementation process. Do not duplicate that workflow in repo docs.
4. Final status must enumerate verified, failing, and unverified acceptance criteria with evidence.

Open issue state changes, so do not hardcode issue status from memory.

## Where Work Usually Goes

- API routes: `src/hono/api/*`
- Envelope persistence and lifecycle behavior: `src/db/envelope/*`
- Passwordless history identity, catalog, and authorization: `src/db/history-access/*`
- Agentic credential authority and document adapters: `src/db/agentic-access/*`
- Agentic browser/token routes and Bearer API: `src/hono/api/agentic.ts`, `src/hono/api/agent-v1*.ts`
- Public Agent guidance/OpenAPI: `src/hono/public-agent-*.ts`
- Agentic UI: `src/routes/agentic-*.tsx`, `src/components/agentic/*`
- API/app routing and the hosted request middleware: `src/omh/hosted-request.ts`, `src/omh/hosted-middleware.ts` (no custom Worker entry; the ohmyho.st build uses TanStack Start's default entry)
- Field placement UI: `src/routes/envelope-fields.tsx`, `src/components/envelopes/*`
- Signer UI and manual smoke path: `src/routes/signing.$token.tsx`, `src/routes/manual-signing-smoke.tsx`, `src/components/signing/*`
- My Documents UI: `src/routes/my-documents*.tsx`, `src/routes/history-access.$credential.tsx`, `src/components/history/*`
- Styling primitives: `src/components/ui/*` are generated Shadcn files; do not edit manually.

## Non-Negotiables

- Prefer deep modules: narrow public interfaces, more private implementation behind them.
- On TanStack UI surfaces, default to TanStack Form for field state and validation, and TanStack Query mutations/queries for async server state. Use React `useState` only for truly local UI toggles or browser-only primitives that do not belong in Form/Query state; do not wire every textbox manually with `useState`.
- Tests live next to source as `*.test.ts` or `*.test.tsx` and verify behavior through public boundaries.
- Mock only external boundaries: DB, R2, network, time, randomness, browser APIs.
- Do not edit generated files: `src/routeTree.gen.ts`, generated migrations, `worker-configuration.d.ts`, or `src/components/ui/*`.
- Keep source files under 500 lines.
- Do not use `any`; use explicit types, `unknown` plus narrowing, or schema-derived types.
- For long-running scripts, add visible heartbeat output with flushing before asking a user to run them.
- Do not quote performance or resource estimates without measurement.

## Commands

```bash
pnpm dev
pnpm types
pnpm test
pnpm lint
pnpm build
pnpm omh:output # build like the ohmyho.st sandbox into dist/ and fail on what its packaging refuses
pnpm agentic:smoke
pnpm agentic:calibrate
pnpm db:generate:dev
pnpm db:migrate:dev
```

`agentic:smoke` and `agentic:calibrate` require a running configured environment and a temporary personal token. Calibration creates and deletes real fixture documents; run it only when new measurement evidence is required, retain its heartbeat/report, and revoke the token afterward.

## Verification

Before declaring code changes ready, run:

```bash
pnpm types
pnpm test
pnpm lint
pnpm build
pnpm omh:output
```

If any check is not run or does not pass, say exactly which acceptance criteria remain unverified and why.
