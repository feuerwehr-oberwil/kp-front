# Documentation

This folder holds KP Front's longer-form documentation: the product concept and the
per-deployment configuration and deployment contracts – the slower-moving "why" and "how".
Day-to-day priorities and plans are discussed in GitHub issues and discussions.

**Status legend:** 🟢 reflects shipped behaviour · 🟡 partially implemented · 🔵 proposed /
not yet built.

## Foundations

The product intent and the "why" (who it's for, the operating model, the standalone
requirement) now live in the [root README](../README.md).

| Doc | Status | What it is |
| --- | --- | --- |
| [`SETUP.md`](SETUP.md) | 🟢 | **Start here for a new station.** The ordered path from an empty Docker host to a deployment that can run an incident: boot, take over the seeded account, station config, station data, integrations, backups – plus the gotchas that catch people and a pre-field checklist. Links to the reference docs below rather than repeating them. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 🟢 | System overview: how the PWA, FastAPI service, Postgres, and external sources fit together, plus where each dataset comes from. Mermaid diagrams for system context, backend modules, config layers, sync/audit flow, and deployment. |
| [`CONFIGURATION.md`](CONFIGURATION.md) | 🟢 | Live data contract for per-deployment configuration: config-as-code/CLI as the primary path, admin UI for inspection/basic edits, the four config layers, reference-data formats, roster/auth notes, and empty-state rules. |
| [`STATION-DATA.md`](STATION-DATA.md) | 🟢 | Practical path from the synthetic example to a private, field-ready station-data repository: layout, provenance, validation, loading, and readiness checks. |
| [`ALARM-INTEGRATIONS.md`](ALARM-INTEGRATIONS.md) | 🟢 | Alarm in/out for any station: generic `POST /api/alarms` intake (auto-open, idempotent, fail-closed), milestone enrichment (`/api/alarms/milestones`), outbound `alarms.webhooks` on incident-create (payload schema, fail-open), the kp-rueck QR-slip example adapter, and the trust models for the Erfassungs-Poster and the read-only Einsatz-Link (`/l/<token>`, one incident, allowlisted, fail-closed). |
| [`STATS-EXPORT.md`](STATS-EXPORT.md) | 🟢 | API reference for the read-only statistics feed `GET /api/stats/incidents`: auth/token model, params, full field table, consumer notes (WinFAP matching). |
| [`geodata-architecture.md`](geodata-architecture.md) | 🟢 | How per-station reference geodata flows from external sources → a private data repo → the deployment → the map. Mermaid diagrams of the ingest paths (`admin_geodata` CLI / API push / Datenquellen UI) and the runtime render. |
| [`objektplaene-architecture.md`](objektplaene-architecture.md) | 🟢 | How the brigade's pre-planned Einsatzobjekte + Modul-PDFs flow from the OneDrive plan library → import/geocode CLI → the deployment, and auto-surface by proximity on incident load. Mermaid diagrams of the importer, refresh path, and runtime render; notes the skipped Modul 4 / 5 (Wasser/PV). Also the optional **pull** – fetching plans from an S3-compatible bucket instead of handing a plan-library system an `ADMIN_SECRET` to push with. |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | 🟢 | Self-hosting / deployment guide: docker-compose quick start (HTTP or auto-HTTPS), config split, updating, backups, data-protection operating notes, and troubleshooting. Tested on a VPS; runs alongside the Railway deployment. |
| [`RUNNING-BOTH.md`](https://github.com/feuerwehr-oberwil/kp-rueck/blob/main/docs/RUNNING-BOTH.md) | 🟢 | **Lives in the kp-rueck repo** (one copy, so the two can't drift). For stations running KP Front *and* KP Rück on one host: the three places two independent stacks collide – host ports (only one can own 443), `PUBLIC_URL` meaning something different in each, and per-deployment alarm secrets with non-interchangeable payloads. |
| [`API.md`](API.md) | 🟢 | HTTP API reference for integrators/contributors: same-origin `/api/*` surface, auth (PIN/JWT + admin-secret), endpoint groups, the config/data CLIs, and where the committed [`openapi.json`](openapi.json) / dev `/docs` live. |
| [`glossary.md`](glossary.md) | 🟢 | German domain-term glossary (Lage, Verlauf, Atemschutz, …) for non-German contributors. |

## Testing ([`testing/`](testing/))

Printable/manual verification material for internal release checks and training-table validation.

| Doc | Status | What it is |
| --- | --- | --- |
| [`testing/manual-limit-test-cards.md`](testing/manual-limit-test-cards.md) | 🟡 | Printable manual test cards for release confidence, limit-finding, offline/sync drills, 118 Magazin Kroki replays, tabletop-game scenarios, report/print checks, and field ergonomics. |
| [`testing/restore-drill-2026-07-02.md`](testing/restore-drill-2026-07-02.md) | 🟢 | Record of an actual backup-restore drill (2026-07-02): what was restored, how long it took, and what the drill found. A worked example for a station running its own drill. |

## Historical

- [`../mockups/`](../mockups/) – early look-and-feel explorations (HTML mockups). Kept for
  reference; the chosen direction was "Karte Minimal". Not maintained.

## Not in this repository

Internal working documents – the roadmap, point-in-time audits, feature planning, operating
notes – stay local and are not published. They are snapshots of a moment, they go stale fast,
and a half-finished register of past worries is a worse answer to "is this software any good?"
than the [CHANGELOG](../CHANGELOG.md), the
[known limitations](../README.md#known-limitations), and the
[open issues](https://github.com/feuerwehr-oberwil/kp-front/issues) – all of which are current.

Per-station data (config, rosters, reference geodata, object plans, checklists) is never in this
repository either – see [`STATION-DATA.md`](STATION-DATA.md).

**Running KP Front and KP Rück at the same station** is documented once, in the sibling project:
[`RUNNING-BOTH.md`](https://github.com/feuerwehr-oberwil/kp-rueck/blob/main/docs/RUNNING-BOTH.md).
One copy on purpose – nothing in it is specific to either repository, and two copies of a document
about two moving systems is two documents to keep true. The two applications stay completely
independent deployments; that guide is only about not doing the shared setup work twice.
