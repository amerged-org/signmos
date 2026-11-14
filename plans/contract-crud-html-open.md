# Vertrags-CRUD, sichere Signatur-Links und PDF-Abschluss

Status: IN PROGRESS

## Akzeptierter Umfang
- API-first Vertragsentwürfe aus PDF + JSON; keine Vorlagenverwaltung.
- POST /api/contracts/drafts; GET Liste/Detail; PATCH Entwurf; PUT /{id}/pdf mit Felddefinition; DELETE nur Entwurf; POST /{id}/send und /cancel.
- Versandaktion liefert persönliche Links und wählt delivery=email oder manual. Manual erzeugt keine Einladung; OTP-Mails beim Empfängerzugang bleiben erforderlich.
- Absender unterschreibt nur, wenn ausdrücklich als Partei angegeben. Keine automatische/fingierte Unterschrift.
- Jeder persönliche Link benötigt einen sechsstelligen E-Mail-Code; auch bisher noch offene Links. Kein Empfängerkonto nötig.
- Nach allen Unterschriften persönliche sichere Download-Links an alle Parteien und Ersteller; kein PDF-Anhang.
- Bestehende Create-and-Send-API, Bearer/CSRF/Idempotency, Eigentümerisolation, unveränderliche Dokumentfassung ab Versand und bestehende Grenzen bleiben erhalten.
- HTML-Upload und HTML-to-PDF: OPEN, bis eine verwaltete Browser-Rendering-Funktion in ohmyho.st verfügbar ist. HTML mit klarem Fehler ablehnen.
- Feature-Feedback an ohmyho.st: Cloudflare Browser Rendering als verwaltete Kundenfunktion mit sicheren HTML/PDF-Aufrufen, privaten Bindings, Kosten-/Limits und Datenschutzanforderungen.
- Sprachwahl bleibt nur Frontend; keine Übersetzung von PDF, Felddaten oder E-Mails.

## Umsetzung und Prüfung
1. CRUD/Draft-Lifecycle mit atomaren Status-/Eigentümerprüfungen und privaten Artefakten.
2. OTP-Challenges mit Ablauf, Rate-Limits, Versuchsgrenze und empfängergebundenen Sitzungen; alle Lese-/Schreib-/Downloadpfade absichern.
3. API-Links und manueller/automatischer Versand; Zustellung der finalen Links über dauerhafte Outbox erst nach erfolgreichem Abschluss.
4. KISS Code-Oberfläche in DE/EN/NL, OpenAPI und Beispiele.
5. Red/Green-Regressionen je Aufgabe, Integration/PGlite, vollständige Typen/Tests/Lint/Build, unabhängige Sicherheits-/Qualitätsprüfung, Dev-Verifikation und exakte Produktionsübernahme.

## Ledger
- Start: vorhandener Arbeitsbaum sauber; Branch codex/amerged-sign-omh.
- HTML rendering remains OPEN by explicit user decision; no external renderer or third-party contract processing added.
- ohmyho.st feature request submitted: 01M7D128EQPZ47BDZ2TCTJEHY1 (2026-11-14), managed Cloudflare Browser Rendering; HTML remains OPEN.
- Superpowers execution used test-first task implementation and independent CRUD / OTP / delivery reviews; implementation remains on the existing authorized `codex/amerged-sign-omh` branch.
- CRUD review: six reproduced findings resolved, including lost transaction receipts, failed-upload reservation recovery, private gateway failure budgets and bounded artifact inventory. See `crud-review.md`.
- OTP/final-delivery review: frozen retry payloads and mutation-time verification recovery fixed; alternating cron queue priority prevents starvation. See `otp-delivery-review.md`.
- Dedicated `SIGN_OTP_SECRET` configured independently for Dev and Prod; no credential values retained in repository evidence.
- Real hosted-dispatch/PGlite/private gateway integration proves successful and failure paths stay within ten subrequests. Source replacement uses nine calls, late upload/save races at most ten. See `integration-task-report.md` and `crud-task-report.md`.
- Release candidate verified: `pnpm types`, `pnpm knip`, `pnpm build`, `git diff --check`, `pnpm lint` (11 advisory warnings, no errors), and all 684 tests across 144 files passed. Hosted Dev/Prod verification follows the code commit.
- Actual protected Dev CRUD, source immutability, OTP denial, health, OpenAPI and unsigned explicit sender participation verified. Private deletion completed after the platform's signed-upload expiry/drain; all synthetic files were erased and all temporary credentials revoked. See `hosted-crud-verification.md`.
- Hosted protocol follow-up: preserve `STORAGE_DELETE_PENDING`, `retryAt` and replay-stable `Retry-After`; safely accept authoritative absent storage reservations while retaining upload fences. Updated source passes all 688 tests across 145 files, types, Knip, build and lint (11 advisory warnings, no errors).
