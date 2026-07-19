# Changelog

All notable changes to KP Front are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it cuts its first tagged release.

`0.1.0` is the initial public release: the git history was squashed for the open-source launch,
so this file — not the log — is the record of what shipped up to that point.

## [Unreleased]

## [0.1.0] — 2026-07-19

### Added
- Deployment-admin auth separated from the incident role: the `/admin` UI and admin-write API
  (config, branding, system, user CRUD, geodata/objects) gate on an `ADMIN_SECRET` session, with
  the `admin_geodata`/`admin_objects` push CLIs authenticating the same way. Fail-closed.
- `just` task runner covering the full lifecycle (setup, dev DB, dev servers, lint/test both
  stacks, build, config-as-code helpers, demo data), plus `just init-env` to generate a `.env`
  with strong secrets.
- Committed config/manifest templates (`backend/config.example.json`,
  `backend/geodata.manifest.example.json`, `backend/objects.manifest.example.json`) and a
  synthetic Musterdorf demo dataset (`examples/demo-data/`, `just demo-load`).
- API reference: committed OpenAPI schema (`docs/openapi.json`, `just openapi`), `docs/API.md`,
  and an `EXPOSE_API_DOCS` flag to opt the interactive docs into production.
- `NOTICE`, `CODE_OF_CONDUCT.md`, and this `CHANGELOG.md`.
- `/ready` readiness endpoint (probes the database and the storage volume, 503 on failure);
  the compose healthcheck and Railway `healthcheckPath` now use it instead of the static
  `/health`.
- Backup tooling: `scripts/backup.sh` (Postgres dump + storage-volume tarball with retention,
  cron-ready) and an automatic pre-migration `pg_dump` in `start.sh` whenever a migration is
  pending (newest 5 kept on the storage volume).
- Confirm-with-undo on the two lossy Gebäude operations (remove floor, replace building) —
  the removed storey/stack and its sketches are restorable from the toast.
- Automatic sync retry with backoff: a failed workspace flush (server error or network drop)
  now re-flushes on 5s→60s backoff instead of waiting for the next manual edit.
- CI security scanning: a blocking gitleaks secret scan of the tracked tree, an advisory
  `pnpm audit` (mirroring the backend's `pip-audit`), and a CodeQL workflow that activates
  automatically once the repository is public.
- Single-editor tab lock (Web Locks): a second browser tab on the same incident is read-only
  with an "In einem anderen Tab geöffnet" banner and a one-tap "Hier bearbeiten" take-over —
  two tabs can no longer race the shared sync cache.
- The Verlauf is now a first-class append-only journal store (server rows + offline outbox)
  instead of an array inside the synced workspace blob — the one unbounded domain no longer
  re-syncs wholesale on every edit. Older incidents migrate lazily and losslessly (the blob
  echoes their rows until each is on the server, then ships empty); transcripts and uploaded
  media URLs are appended enrichment patches, never in-place edits.
- The sync channel is gzip-compressed in both directions (responses via middleware, large
  request bodies via CompressionStream) — repetitive workspace JSON shrinks ~8–10× on
  field LTE.
- The Einsatzende is now first class: archiving stamps `closed_at` (confirm dialog; reopen
  keeps it), both transitions self-document in the Verlauf, post-closure rows carry a
  Nachtrag badge and print in their own Rapport section, the Verlauf gains calendar-day
  separators, and reminders due before closure no longer alarm on reopen.
- Journal Textbausteine: while typing, standard phrases fuzzy-complete the current fragment
  (tap or Tab to accept); the phrase list is station-editable in the admin Journal section.
- Mittel capture + Retablierung: placing a matching tactical symbol (Lüfter, Pumpe, …) on
  Lage or Plan offers logging the material with one tap (never automatic); equipment lines
  carry a Retablierung status (zurück / vor Ort geblieben / defekt) and the Rapport gains a
  «Retablierung / Nachschub» worksheet — refill list, flagged equipment, and still-open
  lines. Catalogue items take optional `symbol` and `verbrauchbar` keys in the deployment
  config; without a `symbol` key a label↔symbol-name match still applies.
- Web Push (VAPID) for killed-app alarms: a server-side sweep recomputes Atemschutz
  überfällig + due Wiedervorlagen from the synced data (same doctrine fallbacks as the
  client) and notifies every subscribed browser — the "tablet stays foregrounded" rule
  becomes a fallback once a deployment sets its VAPID keys.
- New-alarm push: a NEW Divera alarm (webhook or poll) immediately pushes «Neuer Einsatz:
  Stichwort — Adresse» to every subscribed browser, best-effort (a broken push path never
  breaks the intake). VAPID pair generation without Node:
  `cd backend && uv run python -m app.gen_vapid`.
- Tactical symbols: FKS damage signatures (Beschädigung, Teil-/Totalzerstörung) and
  Überschwemmung added to the own-artwork pack (70 signs).

### Changed (assets)
- The tactical symbol pack is now KP-Front-authored artwork (`public/tactical-symbols.json`,
  generated by `tools/gen_symbols.py`, corps-reviewed against the official FKS Faltkarte
  11/2022) — all 66 signs redrawn as clean geometric primitives, same names/categories. The
  backend overlay dataset id moved from `symbols:firegis` to `symbols:tactical`; the legacy
  dataset in existing deployments is simply no longer fetched.

### Removed
- The real station plan PDFs (`public/plans/modul*.pdf`) and the FireGIS symbol-extraction
  tools — station plans are deployment data served from the database; the module tiles in the
  bundled catalog no longer reference any repo asset.
- `public/firegis-symbols.json` and the FireGIS curation scripts, replaced by the authored
  pack above (the last FireGIS-derived asset in the tree).

### Changed
- Smoother app updates: an update discovered right after launch (before any interaction) now
  applies silently instead of asking — the banner only appears for deploys landing mid-work.
  Applying an update shows a calm "Neue Version wird geladen" cover, a watchdog guarantees the
  reload, and the next launch confirms the new build with a toast. The menu's update check
  reports its verdict inline on the button (with a distinct offline message), and standby
  tablets re-check on wake instead of waiting for the hourly poll.
- Incident roles migrated from the legacy `commander` value to `editor`/`viewer` end to end.
- Atemschutz contact timing: the amber "Kontakt fällig" now starts AT the 5-min interval
  (FKS standard) and the hard überfällig alarm fires after a configurable Nachfrist
  (`contactGraceSec`, default 60 s ⇒ red at 6:00). Replaces the previous pre-warning model;
  the old `contactWarnLeadSec` doctrine/setting key is ignored.
- The container now runs as a non-root user (uid 10001). **Existing self-hosted volumes
  created by older root containers may need a one-time
  `docker compose run --rm --user root app chown -R app:app /data/storage`.**

### Fixed
- The Divera webhook now fails closed: with no `DIVERA_WEBHOOK_SECRET` configured it rejects
  all posts (403) instead of accepting unauthenticated alarms. Polling is unaffected.
- A render error on the login screen, landing list, or admin surface now shows the recoverable
  error card instead of a white screen (root-level error boundary + guarded boot init).
