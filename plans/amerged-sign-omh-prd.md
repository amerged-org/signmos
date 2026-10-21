# amerged Sign on ohmyho.st

Requested outcome: fork Signmos, protect contract administration with login, expose a contract-send API, and host it at sign.amerged.com in the amerged workspace.

Acceptance: restricted email-link login; no public account/signup route; recipient links remain functional; personal API tokens are hashed and revocable; authenticated create/upload/send/status/download; ownership and CSRF checks; durable idempotency; private immutable PDF storage and complete deletion of versions; invalid/encrypted PDFs reject truthfully; finalization failure cannot appear completed; limits are consistent in UI and API. Verify types, tests, lint, build, OMH admission and actual hosted flows.

Architecture: preserve TanStack Start/Hono and domain queries. Replace Neon HTTP with a per-request OMH Drizzle proxy. Replace R2 with the private files adapter and add an artifact manifest. Use OMH transactional mail. Use verified-email history sessions for administrator authentication, an explicit allowlist, and existing hashed personal-token primitives. The convenience API supports one external recipient and preserves the original PDF pages while optionally appending a signature page.

Keep signing decisions human-operated. The API creates and sends contracts but does not fabricate recipient consent or signatures. Existing protected Agentic signing decisions keep their review flow.

Hosting: EU region; isolated Dev/Prod data; protected Dev; custom production domain sign.amerged.com. Deployment secrets remain outside Git. Runtime CPU and browser CSP are acceptance gates, not assumptions.
