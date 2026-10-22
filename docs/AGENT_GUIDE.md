> amerged Sign fork: production hosting is ohmyho.st, not an upstream Wrangler deployment. Follow `plans/amerged-sign-omh-prd.md`, `ohmyhost.yaml` and `docs/contracts-api.md`. The global request middleware (`src/omh/hosted-middleware.ts`, registered in `src/start.tsx`) wraps requests with lazy `withDatabase(env, callback)` and administrator authorization; the private OMH Drizzle driver replaces Neon HTTP. Files use the private OMH runtime client; transactional mail uses the OMH runtime mail client over the global `fetch`, not the private mail binding (`src/omh/mail.ts`, `ARCHITECTURE.md`). The upstream Wrangler environments, direct-deployment script and historical release evidence are retained reference material and must not be used to publish this fork. Never deploy to the upstream signmos.com hostname.

# Agent Guide

This guide is the detailed operating manual for agents working in signmos. Keep `AGENTS.md` short; put durable rules here so future runs can load only the relevant sections.

## Context Loading

- Start from `AGENTS.md`.
- For code navigation, read `ARCHITECTURE.md`.
- For product behavior and acceptance criteria, read `plans/simple-esignature-prd.md` plus the relevant feature amendment: `plans/frictionless-signing-ux-prd.md`, `plans/single-signer-mode-prd.md`, `plans/my-documents-prd.md`, or `plans/agentic-mode-prd.md`.
- For issue implementation, fetch the live GitHub issue, then read the matching local plan in `plans/issues/` if it exists.
- For API examples and manual smoke instructions, read `README.md`.
- Do not load all docs by default. Add context only when the current task needs it.

## Issue Implementation

- Fetch the live issue body before implementing: `gh issue view <number> --json number,title,body,state,labels,url`.
- Read the product and architecture docs relevant to the issue.
- Load the local TDD skill from this machine for the implementation loop. This repo does not duplicate that skill's workflow.
- Use issue acceptance criteria as the source of implementation scope.
- End with an acceptance-criteria evidence table: verified, failing, unverified, and evidence.

## Measurement And Resource Criteria

- Numeric acceptance criteria need tests or measured checks.
- Do not quote runtime or memory estimates unless measured on representative data, extrapolated from a stated calibration, or sourced from a documented benchmark.
- Long-running commands or scripts need heartbeat output with `flush` or unbuffered execution before a user waits on them.

## TypeScript Rules

- Never use `any`.
- Prefer `unknown` over `any`, then narrow with type guards.
- Prefer discriminated unions over boolean mode flags.
- Use `satisfies` for type-safe object literals with useful inference.
- Use `as const` for readonly literal data.
- Add explicit return types on public APIs.
- Guard indexed array access. Prefer `for...of` when the index is not needed.
- Use kebab-case filenames, PascalCase types/interfaces, camelCase functions/variables, and UPPER_SNAKE_CASE only for true constants.

## Deep Modules

A deep module has a small public interface hiding a larger implementation.

- Before creating a file, ask whether it deepens an existing module or widens the public surface.
- Before exporting a helper, ask whether callers really need it.
- Test at module boundaries, not internals.
- If an internal function needs direct tests, consider splitting the module at a real boundary.

| Layer | Boundary | Interface | Hides |
| --- | --- | --- | --- |
| DB domain | `src/db/{domain}/index.ts` | Exported queries and types | Tables, query builders, persistence details |
| API endpoint | `src/hono/api/{name}.ts` | HTTP routes | Validation, status codes, error mapping |
| Component feature | `src/components/{feature}/` | Props and named exports | UI state, mutations, local composition |
| Server function | `src/core/functions/` | `createServerFn` signature | Auth, data fetching, transforms |

## Error Handling

- Known recoverable failures use structured errors with a stable `code`, `message`, and status.
- `AppError` and `Result<T>` live in `src/core/errors.ts`.
- Unexpected errors should propagate to the global handler/logging path.
- Drizzle wraps Postgres errors; inspect `error.cause.code` for pg codes such as `23505`, not `error.message`.
- Success responses use `{ data: ... }`; paged responses may add `{ meta: ... }`.
- Error responses should use `{ error: { code, message, ... } }` for lifecycle APIs.

## Hono And Worker Rules

- There is no custom Cloudflare Worker entry: the ohmyho.st build bundles TanStack Start's default server entry, and `wrangler.jsonc` names it.
- `src/omh/hosted-request.ts`, run by the first global request middleware (`src/omh/hosted-middleware.ts`), scopes the private OMH database and storage from env bindings, applies the administrator gate, routes `/api/*` to Hono, serves `/agent.md` and `/openapi.json` through the public Agent contract publisher, and lets everything else continue into TanStack Start.
- Access bindings through `env` or `c.env`, never `process.env`.
- Workers are stateless. Do not rely on mutable global request state.
- Use `waitUntil()` for non-blocking work after a response when needed.
- Hono handlers should be thin: validate request input, call a domain function, map response/error shape.
- Prefer named Zod schemas from the relevant DB domain. Do not inline large `z.object()` schemas in route handlers.

## Agentic API Rules

- `/api/agentic/*` is browser-management-session authority; `/api/v1/*` is personal Bearer document authority. Neither credential class may substitute for the other.
- Resolve the normalized-email Bearer principal and current creator/signer role on every request. Never authorize a document from token possession alone.
- Every `/api/v1` `POST`, `PUT`, `PATCH`, and `DELETE` requires `Idempotency-Key`, exact replay for an identical request, and `IDEMPOTENCY_CONFLICT` for changed reuse. Route enumeration must leave no mutation exempt.
- Runtime Zod schemas and operation metadata are the source for `/openapi.json`. Update the public contract and drift test with every route/schema change.
- Keep `/agent.md` complete for workflows, structured-error recovery, polling/backoff, goal-directed execution, and secret safety; do not duplicate its full operation catalog in static docs.
- Raw Agentic links, management sessions, Bearer secrets, and hashes must stay out of URLs, redirects, later responses, logs, errors, audits, analytics, email content outside intended one-time link delivery, screenshots, and retained evidence.
- Rate-limit policy changes require representative calibration evidence plus below/exact/above tests for both token and IP bounds. Do not infer throughput or SLA claims from latency samples.
- Agentic release changes must preserve the capability matrix, live `pnpm agentic:smoke`, credential-canary scan, and existing browser compatibility evidence.

## Drizzle, Neon, And Zod Rules

- Domain tables live in `src/db/{domain}/table.ts`.
- Validation schemas and response adapters live in `src/db/{domain}/schema.ts`.
- Query and lifecycle functions live in `src/db/{domain}/queries.ts`.
- Public re-exports live in `src/db/{domain}/index.ts`.
- Query functions call `getDb()` internally; do not pass DB handles through app code.
- Use `.returning()` on mutations when the caller needs inserted/updated rows.
- Use Neon HTTP through `drizzle-orm/neon-http`; initialize once per Worker isolate with `initDatabase()`.
- Use Zod at trust boundaries: request input, route params, external API responses, and serialized server/client data.
- Derive TypeScript types with `z.infer`; do not duplicate schema types manually.
- Do not use `z.unknown()` in schemas crossing the TanStack server-to-client serialization boundary. Use serializable values.
- Never manually edit generated migrations. Generate them with the environment-specific `pnpm db:generate:*` script.

## React, TanStack, And UI Rules

- Routes live in `src/routes/`; `src/routeTree.gen.ts` is generated and must not be edited.
- Keep route files thin. Put feature UI in `src/components/{feature}/`.
- Components use named exports and a props interface above the component.
- Use TanStack Router loaders for initial route data when appropriate.
- Use TanStack Query `queryOptions` and query-key factories for reusable queries.
- Use TanStack Form plus React Query mutations for non-trivial forms. Avoid raw `useState` form models for complex forms.
- When `validateSearch` uses defaults, provide fallback defaults inside `navigate({ search: prev => ... })` callbacks.
- Use lucide icons for icon buttons when available.
- Use Tailwind CSS v4 with theme variables. Do not hardcode palette colors such as `text-gray-*`, `bg-white`, or `text-black`.
- Use semantic variants such as `text-destructive`, `bg-success/10`, and Shadcn variants.
- Preserve accessibility: labels, keyboard navigation, focus states, and contrast.

## Generated And Protected Files

- Do not manually edit `src/components/ui/*`; use Shadcn tooling.
- Do not manually edit `src/routeTree.gen.ts`.
- Do not manually edit generated migration files.
- Do not manually edit `worker-configuration.d.ts`; run `pnpm cf-typegen`.
- Combine import additions with their usage in one edit so formatter hooks do not remove unused imports between edits.

## Cloudflare Deployment Rules

- Use `wrangler.jsonc`, not `wrangler.toml`.
- Prefer `custom_domain: true` over route patterns that require manual proxied DNS records.
- Do not use Cloudflare redirect rules that intercept Worker custom domains and create redirect loops.
- SSL/TLS mode must be Full or Full strict, not Flexible.
- With the Cloudflare Vite plugin, environment config is baked into the build mode; deploy the configured build.

## Verification

Run before declaring code changes ready:

```bash
pnpm types
pnpm test
pnpm lint
pnpm build
```

For docs-only changes, run the smallest relevant check, usually `pnpm lint`, unless a doc contract test or generated index is affected.

When finishing, report acceptance-criteria status explicitly. Do not say "complete" unless every required acceptance criterion is verified or intentionally out of scope with evidence.

## Big Task Closeout

For substantial tasks, end with:

1. Next actions I can do right now
2. Automations or systems I can set up
3. Things to delegate to your team

Keep it to 3-5 bullets total and make the bullets concrete.
