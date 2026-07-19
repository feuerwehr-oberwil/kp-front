# Documentation

This folder holds KP Front's longer-form documentation: the product concept and the
per-deployment configuration and deployment contracts — the slower-moving "why" and "how".
Day-to-day priorities and plans are discussed in GitHub issues and discussions.

**Status legend:** 🟢 reflects shipped behaviour · 🟡 partially implemented · 🔵 proposed /
not yet built.

## Foundations

The product intent and the "why" (who it's for, the operating model, the standalone
requirement) now live in the [root README](../README.md).

| Doc | Status | What it is |
| --- | --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 🟢 | System overview: how the PWA, FastAPI service, Postgres, and external sources fit together, plus where each dataset comes from. Mermaid diagrams for system context, backend modules, config layers, sync/audit flow, and deployment. |
| [`CONFIGURATION.md`](CONFIGURATION.md) | 🟢 | Live data contract for per-deployment configuration: config-as-code/CLI as the primary path, admin UI for inspection/basic edits, the four config layers, reference-data formats, roster/auth notes, and empty-state rules. |
| [`STATION-DATA.md`](STATION-DATA.md) | 🟢 | Practical path from the synthetic example to a private, field-ready station-data repository: layout, provenance, validation, loading, and readiness checks. |
| [`ALARM-INTEGRATIONS.md`](ALARM-INTEGRATIONS.md) | 🟢 | Alarm in/out for any station: generic `POST /api/alarms` intake (auto-open, idempotent, fail-closed), milestone enrichment (`/api/alarms/milestones`), outbound `alarms.webhooks` on incident-create (payload schema, fail-open), the kp-rueck QR-slip example adapter, and the Erfassungs-Poster trust model. |
| [`STATS-EXPORT.md`](STATS-EXPORT.md) | 🟢 | API reference for the read-only statistics feed `GET /api/stats/incidents`: auth/token model, params, full field table, consumer notes (WinFAP matching). |
| [`geodata-architecture.md`](geodata-architecture.md) | 🟢 | How per-station reference geodata flows from external sources → a private data repo → the deployment → the map. Mermaid diagrams of the ingest paths (`admin_geodata` CLI / API push / Datenquellen UI) and the runtime render. |
| [`objektplaene-architecture.md`](objektplaene-architecture.md) | 🟢 | How the brigade's pre-planned Einsatzobjekte + Modul-PDFs flow from the OneDrive plan library → import/geocode CLI → the deployment, and auto-surface by proximity on incident load. Mermaid diagrams of the importer, refresh path, and runtime render; notes the skipped Modul 4 / 5 (Wasser/PV). |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | 🟢 | Self-hosting / deployment guide: docker-compose quick start (HTTP or auto-HTTPS), config split, updating, backups, data-protection operating notes, and troubleshooting. Tested on a VPS; runs alongside the Railway deployment. |
| [`API.md`](API.md) | 🟢 | HTTP API reference for integrators/contributors: same-origin `/api/*` surface, auth (PIN/JWT + admin-secret), endpoint groups, the config/data CLIs, and where the committed [`openapi.json`](openapi.json) / dev `/docs` live. |
| [`glossary.md`](glossary.md) | 🟢 | German domain-term glossary (Lage, Verlauf, Atemschutz, …) for non-German contributors. |

## Testing ([`testing/`](testing/))

Printable/manual verification material for internal release checks and training-table validation.

| Doc | Status | What it is |
| --- | --- | --- |
| [`testing/manual-limit-test-cards.md`](testing/manual-limit-test-cards.md) | 🟡 | Printable manual test cards for release confidence, limit-finding, offline/sync drills, 118 Magazin Kroki replays, tabletop-game scenarios, report/print checks, and field ergonomics. |

## Historical

- [`design-concepts/`](design-concepts/) and [`../mockups/`](../mockups/) — early look-and-feel
  explorations (HTML mockups). Kept for reference; the chosen direction was "Karte Minimal".
  Not maintained.
