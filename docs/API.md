# API reference

KP Front's backend is a single FastAPI service that **serves the SPA same-origin** and exposes
its HTTP API under `/api/*`. There is no separate API host and no CORS surface – one deployment
is one station (single-tenant). Most users never touch the API directly: the app is the client,
and per-station setup goes through `/admin` in a browser, or through the
[admin CLIs](#configuration--data-cli) where a station wants its config as reviewable files. This
page is for integrators and contributors.

## OpenAPI schema

The full contract is committed as [`openapi.json`](openapi.json) (regenerate with `just openapi`).

Interactive docs (`/docs` Swagger, `/redoc`, `/openapi.json`) are served **in development**. In
production they are **off by default** – set `EXPOSE_API_DOCS=true` to enable them on a deployed
instance for integration work.

| Environment | `/docs`, `/openapi.json` |
| --- | --- |
| dev (`uv run uvicorn …`) | always on |
| production | off, unless `EXPOSE_API_DOCS=true` |

## Authentication

PIN-kiosk flow issuing JWTs as **httpOnly cookies** (single-origin, so no tokens in JS):

1. `GET /api/auth/roster` – public list of login tiles (active users, no secrets).
2. `POST /api/auth/login` `{user_id, pin}` – sets `access_token` + `refresh_token` cookies.
3. `POST /api/auth/refresh` – rotates the pair; `POST /api/auth/logout` revokes them.
4. `GET /api/auth/me` – the current user.

**Two authorization layers:**

- **Incident role** – `editor` (can mutate incident state) vs `viewer` (read-only). Mutating
  incident endpoints require `editor`.
- **Deployment admin** – the `/admin` surface and admin-write endpoints (config, branding,
  system, user CRUD, geodata/objects) require an **admin session**, unlocked by the deployment
  `ADMIN_SECRET` via `POST /api/admin/login` `{secret}` – separate from the editor PIN, and
  fail-closed when `ADMIN_SECRET` is unset. See [CONFIGURATION.md](CONFIGURATION.md) §5.

## Endpoint groups

| Prefix | Purpose | Auth |
| --- | --- | --- |
| `/api/auth/*` | login / refresh / logout / me; user CRUD (`/users`) | public · admin (user CRUD) |
| `/api/admin/*` | admin-session login / logout / state | secret |
| `/api/config`, `/api/branding`, `/api/system` | deployment config, branding assets, maintenance status | read public (config) · admin (writes) |
| `/api/integrations/*` | integration credentials + their audit trail (see below) | admin |
| `/api/station-workbook/*` | the station-data `.xlsx` – export, preview, import (see below) | admin |
| `/api/incidents/*`, `/api/events/*` | incident CRUD, workspace sync, notes, append-only events | editor (mutations) |
| `/api/objects/*`, `/api/reference/*` | object library + plans, reference geodata layers | read auth · admin (writes) |
| `/api/media/*` | photo / audio upload + serve | editor |
| `/api/personnel/*`, `/api/divera/*`, `/api/traccar/*` | roster, alarm/roster pull, vehicle GPS | editor |
| `/api/weather`, `/api/geocode` | wind badge, address search (backend-proxied) | auth |
| `/api/report/*` | report data (read-only output) | auth |
| `/api/incident-link/*` | exchange an alerting system's link token for a read-only session on one incident (`/l/<token>`); key management | station `incident_link_key` (session) · admin (key) · fail-closed |
| `/api/diag/client-error` | client error sink (bounded, logged at WARNING) | none |

The exact request/response shapes are in [`openapi.json`](openapi.json) / the live `/docs`.

**Three routes outside `/api/*`**, all unauthenticated because the caller has no session to
offer – a container runtime, a monitor, or the browser itself:

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness, static by design. Returns `status`, `service`, `version` **plus `commit` and `built_at`** – the build, not just the release, so a from-source `main` is distinguishable from a three-day-old published image (`Settings.build`) |
| `GET /ready` | readiness: probes the database *and* the storage volume. Point container and platform healthchecks here – `/health` reports ok with an unreachable database |
| `GET /manifest.webmanifest` | the PWA manifest, **generated per deployment** rather than served from `dist/`: the build-time file is the base and the station's `identity.appName`, `locale`, `accentColor` and app icons are overlaid on it. Never 500s (any garbage degrades to the built manifest), never cached, never authenticated |

## Integration credentials – `/api/integrations/*`

The sixteen integration settings a station may set from `/admin` → Zugangsdaten instead of
`.env`: the three Divera keys, the Traccar trio, the VAPID trio, the four STT settings,
`ALARM_WEBHOOK_SECRET`, `PRINT_AGENT_SECRET` and `HEALTHCHECK_PING_URL`. Stored encrypted
(AES-256-GCM, key derived from `SECRET_KEY` via HKDF) and live without a restart. Contract and
reasoning: [`CONFIGURATION.md` §6](CONFIGURATION.md#6-environment-variables-secrets--infra--operator-not-admin).

| Route | Purpose |
| --- | --- |
| `GET /api/integrations/credentials` | every settable credential and where it comes from – `CredentialState[]` |
| `PUT /api/integrations/credentials/{name}` | set or replace one – body `{ "value": "…" }` (1–2048 chars) |
| `DELETE /api/integrations/credentials/{name}` | clear the stored value; the integration falls back to off |
| `GET /api/integrations/credentials-audit` | `?limit=` (default 30, capped at 200) – `CredentialAuditEntry[]`: `name`, `label`, `action`, `source`, `at`, `by` (null = nobody was signed in behind it), newest first. **The record, never the values.** |

All four require an **admin session** – the same `ADMIN_SECRET` gate as the rest of `/admin`,
not the editor PIN. `{name}` is the lowercase field name (`divera_access_key`,
`vapid_private_key`, `alarm_webhook_secret`, …); an unknown one is `404`.

Three rules the shapes encode:

- **Secrets are write-only.** `CredentialState` carries `configured` and `source`
  (`env` | `stored` | `unset` | `unreadable`), and `value` **only** for the six fields flagged
  non-secret: `traccar_url`, `vapid_public_key`, `vapid_subject`, `stt_base_url`, `stt_model`,
  `stt_language`. There is no admin level at which a Divera key becomes readable – setting and
  rotating from a phone at 3am beats SSH, exfiltrating from one does not.
- **`.env` wins.** A field the environment supplies reports `source: "env"` and refuses both
  `PUT` and `DELETE` with **409**, naming the env var in `CredentialState.env` so the page can
  say where the value comes from. "Supplied" means *differs from the declared default* –
  `docker-compose.yml` names all sixteen variables and materialises the app's own default for
  `STT_MODEL`, `STT_LANGUAGE` and `VAPID_SUBJECT`, which is not a deployer decision.
- **`unreadable` is not `unset`.** A row that will not decrypt (i.e. `SECRET_KEY` was rotated)
  reports `source: "unreadable"` and `configured: false`, so the operator is told to set it
  again rather than sent looking for a setting they already made.

## Station workbook – `/api/station-workbook/*`

One `.xlsx` a station downloads, edits and uploads back; sheets `Mannschaft`, `Dienstgrade`,
`Fahrzeuge`, `Mittel`, `Mittel-Bestände`, `Quellen`, `Partnerorganisationen`, `Symbolfelder`.
**Admin session on all three routes**, and **upsert only** – there is no replace mode and no
mode parameter to add one to. What it does and does not cover:
[`CONFIGURATION.md` §9h](CONFIGURATION.md#9h-the-station-workbook--one-xlsx-for-the-list-shaped-data).

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/station-workbook/export` | – | the `.xlsx` bytes (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`), `Content-Disposition: attachment; filename="stationsdaten-<YYYY-MM-DD>.xlsx"`. ⚠️ `openapi.json` types this `200` as JSON with an empty schema – that is FastAPI's default for a bare `Response`, not the contract |
| `POST /api/station-workbook/preview` | `multipart/form-data`, `file` | `WorkbookPreview` – **writes nothing** |
| `POST /api/station-workbook/import` | `multipart/form-data`, `file` + optional `digest` | `WorkbookImportResult` |

`WorkbookPreview` is the confirmation screen's whole payload: `sheets[]`, `errors[]`,
`warnings[]`, `emptied[]`, `digest`, `ok`. One `SheetImpact` per sheet carries `sheet`,
`present`, `rows`, `created`, `updated`, `unchanged`, `removed[]` (named, capped at 8),
`removed_total` and `removal_kind` – `"removed"` | `"deactivated"` | `"none"`. Those last two
words are the contract, not phrasing: a person missing from `Mannschaft` is **deactivated**
(closed incidents resolve names through the row), an id missing from an id-keyed sheet is
**removed**. A sheet that is not in the file at all comes back `present: false` and changes
nothing.

`digest` is the SHA-256 the preview reported for the bytes it read. Sent back to `import` it is
verified against the uploaded file and a mismatch is **409** – the file was edited between
preview and confirm. It is deliberately **optional**, so a script may import without previewing;
the confirm handshake is an operator guarantee, not an enforced protocol. `import` is
all-or-nothing (`ok: false` → **400**, nothing written), and every write that changes the
**config** keeps the document it replaced under source `workbook`, so «Letzte Änderungen» can undo
that half.

⚠️ **The Mannschaft half is not covered by config history.** Personnel live in their own table;
`keep_previous` runs only when a config section actually changed, so a Mannschaft-only import
writes no history row at all. What limits the damage instead: a person missing from the sheet is
**deactivated, never deleted** (past incidents still reference them), so the reverse is a
re-activation rather than a recovery. The undo for the roster is the export taken **before** the
import.

Refusals: a filename not ending `.xlsx` → **400**, an empty file → **400**, over
`MAX_UPLOAD_MB` → **413**. Refused rows come back in `errors[]` as
`«<Blatt> Zeile <N> – <reason>»`, or `«Blatt <Blatt> – <reason>»` where the fault is the sheet
rather than one row (header mismatch, dropping a `Quelle` stock still points at, dropping a
`Dienstgrad` somebody still carries).

## Configuration & data CLI

Per-station config and reference data can be **config-as-code**, applied with five sibling CLIs
(run from `backend/`, or prefixed with `docker compose exec app` on a Docker-only host; `just
config-*` / `geodata-load` / `objects-load` wrap the common ones). Each of the five now also has a
browser equivalent for one item at a time – see
[`CONFIGURATION.md` §9](CONFIGURATION.md#9-loading-station-data-with-the-admin-clis) for which
door to use when:

| CLI | Manages | Example |
| --- | --- | --- |
| `python -m app.admin_config` | the `deployment_config` document (identity, map, fleet, doctrine, roster, …) | `just config-example`, `just config-load <file>` |
| `python -m app.admin_branding` | branding assets – the five slots `logo`, `reportLogo`, `favicon`, `iconPng192`, `iconPng512` | `push reportLogo <file>`, `show` |
| `python -m app.admin_geodata` | reference geodata layers (hydrants, WMS) | `just geodata-load <manifest>` |
| `python -m app.admin_objects` | object library + Modul-PDF plans | `just objects-load <manifest>` |
| `python -m app.admin_checklists` | checklist templates + playbook diagram assets | `validate <manifest>`, `push <manifest>` |

**Which verbs each one has:**

| | `schema` | `example` | `validate` | `diff` | `load` | `push` | `show` |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `admin_config` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `admin_branding` | – | – | – | – | ✅ | ✅ | ✅ |
| `admin_geodata` | ✅ | ✅ | ✅ | – | ✅ | ✅ | ✅ |
| `admin_objects` | ✅ | ✅ | ✅ | – | ✅ | ✅ | ✅ |
| `admin_checklists` | ✅ | ✅ | ✅ | – | ✅ | ✅ | ✅ |

`admin_config` also has `history` / `restore`. **All five support `push`** – `admin_config push`
landed in `55c4a94`, so nothing needs a database connection any more. Which verb to use where is
[`CONFIGURATION.md` §9a](CONFIGURATION.md#9a-what-all-of-them-share); the short version is `push`
for a running deployment, `load` only where the database and the storage directory are both the
deployment's own.

### Starting templates

Four manifest/config templates are committed in `backend/`. **Only one of them validates as
committed** – the other three deliberately reference files that are not in this repository,
because the PDFs, GeoJSON and checklist JSON they point at are station data:

| Template | `validate` out of the box | What it still needs |
| --- | --- | --- |
| `config.example.json` | ✅ passes | nothing – it is a complete document, edit it in place |
| `geodata.manifest.example.json` | ❌ `layer 'lk-hydrant' file not found: hydrant.geojson` | a WGS84 GeoJSON next to the manifest, or drop the `geojson` entry and keep the WMS one |
| `objects.manifest.example.json` | ❌ `plan 'modul1' file not found: plans/dorfmatt/modul1.pdf` | a `plans/dorfmatt/` folder with the four Modul-PDFs it names |
| `checklists.manifest.example.json` | ❌ `entry 'fu-aktion' template file not found` | three template JSONs under `checklists/` plus the two diagram images |

They are shape references, not runnable starting points. **For something that actually runs,
copy [`examples/demo-data/`](../examples/demo-data/)** – manifests *and* the files they point at,
loaded in the right order by [`load.sh`](../examples/demo-data/load.sh).

Full data contract in [CONFIGURATION.md](CONFIGURATION.md); the station-data workflow is
[STATION-DATA.md](STATION-DATA.md).
