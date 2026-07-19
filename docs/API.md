# API reference

KP Front's backend is a single FastAPI service that **serves the SPA same-origin** and exposes
its HTTP API under `/api/*`. There is no separate API host and no CORS surface — one deployment
is one station (single-tenant). Most users never touch the API directly: the app is the client,
and per-station setup goes through the [admin CLIs](#configuration--data-cli). This page is for
integrators and contributors.

## OpenAPI schema

The full contract is committed as [`openapi.json`](openapi.json) (regenerate with `just openapi`).

Interactive docs (`/docs` Swagger, `/redoc`, `/openapi.json`) are served **in development**. In
production they are **off by default** — set `EXPOSE_API_DOCS=true` to enable them on a deployed
instance for integration work.

| Environment | `/docs`, `/openapi.json` |
| --- | --- |
| dev (`uv run uvicorn …`) | always on |
| production | off, unless `EXPOSE_API_DOCS=true` |

## Authentication

PIN-kiosk flow issuing JWTs as **httpOnly cookies** (single-origin, so no tokens in JS):

1. `GET /api/auth/roster` — public list of login tiles (active users, no secrets).
2. `POST /api/auth/login` `{user_id, pin}` — sets `access_token` + `refresh_token` cookies.
3. `POST /api/auth/refresh` — rotates the pair; `POST /api/auth/logout` revokes them.
4. `GET /api/auth/me` — the current user.

**Two authorization layers:**

- **Incident role** — `editor` (can mutate incident state) vs `viewer` (read-only). Mutating
  incident endpoints require `editor`.
- **Deployment admin** — the `/admin` surface and admin-write endpoints (config, branding,
  system, user CRUD, geodata/objects) require an **admin session**, unlocked by the deployment
  `ADMIN_SECRET` via `POST /api/admin/login` `{secret}` — separate from the editor PIN, and
  fail-closed when `ADMIN_SECRET` is unset. See [CONFIGURATION.md](CONFIGURATION.md) §5.

## Endpoint groups

| Prefix | Purpose | Auth |
| --- | --- | --- |
| `/api/auth/*` | login / refresh / logout / me; user CRUD (`/users`) | public · admin (user CRUD) |
| `/api/admin/*` | admin-session login / logout / state | secret |
| `/api/config`, `/api/branding`, `/api/system` | deployment config, branding assets, maintenance status | read public (config) · admin (writes) |
| `/api/incidents/*`, `/api/events/*` | incident CRUD, workspace sync, notes, append-only events | editor (mutations) |
| `/api/objects/*`, `/api/reference/*` | object library + plans, reference geodata layers | read auth · admin (writes) |
| `/api/media/*` | photo / audio upload + serve | editor |
| `/api/personnel/*`, `/api/divera/*`, `/api/traccar/*` | roster, alarm/roster pull, vehicle GPS | editor |
| `/api/weather`, `/api/geocode` | wind badge, address search (backend-proxied) | auth |
| `/api/report/*` | report data (read-only output) | auth |
| `/api/diag/client-error` | client error sink (bounded, logged at WARNING) | none |

The exact request/response shapes are in [`openapi.json`](openapi.json) / the live `/docs`.

## Configuration & data CLI

Per-station config and reference data are **config-as-code**, applied with three CLIs (run from
`backend/`, or via the `just config-*` / `geodata-*` / `objects-*` recipes):

| CLI | Manages | Example |
| --- | --- | --- |
| `python -m app.admin_config` | the `deployment_config` document (branding, map, fleet, doctrine, …) | `just config-example`, `just config-load <file>` |
| `python -m app.admin_geodata` | reference geodata layers (hydrants, WMS) | `just geodata-load <manifest>` |
| `python -m app.admin_objects` | object library + Modul-PDF plans | `just objects-load <manifest>` |

Each supports `schema` / `example` / `validate` / `load` (local DB) / `show`; `admin_geodata`
and `admin_objects` also support `push` (over a running deployment's HTTP API, authenticated
with `KP_ADMIN_SECRET`). Start from the committed templates: `backend/config.example.json`,
`backend/geodata.manifest.example.json`, `backend/objects.manifest.example.json`. Full data
contract in [CONFIGURATION.md](CONFIGURATION.md).
