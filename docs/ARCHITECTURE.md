# Architecture

How KP Front is put together and where its data comes from. For the reference-geodata flow
specifically, see [`geodata-architecture.md`](geodata-architecture.md); for the per-deployment
config contract, [`CONFIGURATION.md`](CONFIGURATION.md); for running it,
[`DEPLOYMENT.md`](DEPLOYMENT.md).

The shape in one sentence: a tablet-first **PWA** talks to a single **FastAPI** service that
serves the app same-origin, owns a **PostgreSQL** database and an asset store, and is the only
thing that reaches **external services** — one deployment per station, no multi-tenancy.

## System context

```mermaid
flowchart TB
  subgraph CLIENT["Browser — installable PWA (one tablet per command point)"]
    UI["Lage (map) · Plan (whiteboard)<br/>React + TypeScript + MapLibre GL"]
    SW["Service worker (Workbox)<br/>app-shell precache · runtime cache · offline"]
    LS[("localStorage<br/>incident doc · device prefs")]
    UI --- SW
    UI --- LS
  end

  subgraph DEP["Deployment — one per station (single-tenant)"]
    API["FastAPI service<br/>serves the SPA same-origin (no CORS)<br/>auth · workspace sync · audit · integrations"]
    DB[("PostgreSQL<br/>incidents · events · config · roster")]
    FILES[("Asset storage (volume / S3)<br/>plans · media · reference GeoJSON · symbols")]
    API --- DB
    API --- FILES
  end

  subgraph EXT["External services (backend-proxied, SSRF-guarded)"]
    DIV["Divera 24/7<br/>alarm · roster"]
    TRC["Traccar<br/>vehicle GPS"]
    GEO["swisstopo / geo.admin<br/>geocoder"]
    WX["MeteoSwiss → Open-Meteo<br/>weather / wind"]
  end

  TILES["Raster map tiles<br/>swisstopo WMTS · OSM · canton WMS"]
  PRIV["Station's private data repo<br/>(hydrants · Leitungskataster · …)"]

  UI -->|"/api/* — same-origin, JWT cookie"| API
  API --> DIV
  API --> TRC
  API --> GEO
  API --> WX
  UI -. "tiles fetched directly by the browser" .-> TILES
  PRIV -. "admin_geodata load / push" .-> FILES
```

## Where the data comes from

| Data | Source | How it reaches the app | Offline |
| --- | --- | --- | --- |
| Tactical symbols (FKS) | KP-Front-authored (`tools/gen_symbols.py`) | bundled `public/tactical-symbols.json`, also seeded into the reference store | ✅ cached |
| Hazmat UN-Nr → Stoff (ADR) | UNECE ADR table | bundled `src/data/unHazard.json` | ✅ in-app |
| Base map tiles | swisstopo WMTS · OSM · canton WMS | **browser fetches tile servers directly** | ⚠️ only pre-cached areas |
| Geocoding / address search | swisstopo geo.admin | backend proxy `GET /api/geocode` | ✗ online only |
| Weather / wind | MeteoSwiss → Open-Meteo fallback | backend proxy `GET /api/weather` | last value cached |
| Alarm + roster | Divera 24/7 | backend proxy `/api/divera`, `/api/personnel` | roster cached |
| Live vehicle GPS | Traccar | backend proxy `/api/traccar` | ✗ live only |
| Reference geodata (hydrants, Leitungskataster, canton WMS) | the station's own (often private) data repo | `admin_geodata` → reference store + `config.referenceLayers` (see [`geodata-architecture.md`](geodata-architecture.md)) | ✅ GeoJSON cached (WMS tiles online) |
| Incident state · Verlauf · exports | **the operator (this app)** | workspace sync + append-only event log in Postgres | ✅ localStorage + queued sync |

Three classes: **bundled** (offline, ships in the app), **backend-proxied** (cached, one
SSRF-guarded client per service), and **browser-direct** (raster tiles only). No station data
is bundled — see the geodata doc for why.

## Backend modules

```mermaid
flowchart LR
  subgraph EDGE["FastAPI routers (/api/*)"]
    AUTH["auth<br/>PIN → JWT · roles · rate-limit"]
    INC["incidents<br/>workspace sync (LWW + rev)"]
    EVT["events<br/>append-only Verlauf"]
    CFG["config<br/>GET (public) / write via CLI/admin"]
    REF["reference<br/>symbols · geodata · plans"]
    PERS["personnel<br/>roster (Divera / manual / CSV)"]
    INTEG["divera · traccar<br/>geocode · weather"]
  end

  subgraph CORE["Core services"]
    AUD["audit.py<br/>hash-chain + snapshots"]
    STG["storage.py<br/>local volume / S3"]
  end

  DB[("PostgreSQL")]
  FILES[("Asset storage")]
  EXTSVC["External APIs"]

  AUTH --> DB
  INC --> AUD --> DB
  EVT --> AUD
  CFG --> DB
  PERS --> DB
  REF --> STG --> FILES
  INTEG --> EXTSVC
```

Auth is a PIN-kiosk login issuing JWTs in httpOnly cookies. Product roles are **editor** (FU /
incident editing) and **viewer** (read-only); the stored backend value was migrated from the
legacy `commander` name to `editor` on 2026-06-30. Deployment
administration should be separated behind env-var-backed admin auth instead of piggybacking on the
incident editor role.
Incident state is one workspace blob per incident; the audit trail (`audit.py`) hash-chains
every change and keeps fold snapshots so an incident can be replayed and verified
(`GET /api/incidents/{id}/verify`).

## Configuration: four layers

```mermaid
flowchart TB
  subgraph PREC["Resolution order — highest wins, falls back downward"]
    direction TB
    L4["4 · Per-incident — workspace blob (synced, any user)"]
    L2["2 · Per-station — deployment_config DB row (CLI/config files primary; admin UI helper)"]
    L1["1 · National defaults — code (appConfig.ts · config.py)"]
    L4 --> L2 --> L1
  end
  L3["3 · Secrets — environment variables (infra only, never in the UI)"]
  L3 -. "configures" .-> L2
```

A station's config is a single `deployment_config` row served at `GET /api/config` and applied
at boot to override the code defaults. Edit it as code with
`uv run python -m app.admin_config <schema|example|validate|diff|load>`. See
[`CONFIGURATION.md`](CONFIGURATION.md).

## Sync & audit flow

```mermaid
sequenceDiagram
  participant A as Device A (editor)
  participant API as FastAPI
  participant DB as PostgreSQL
  participant B as Device B
  A->>API: PUT workspace (full blob)
  API->>API: merge per object by id (last-write-wins)
  API->>DB: append IncidentEvent (hash-chained)
  API->>DB: store workspace + workspace_rev++
  API-->>A: 200 (new rev)
  B->>API: GET workspace?since=rev
  API-->>B: 200 newer blob — or 304 unchanged
  Note over API,DB: /api/incidents/{id}/verify re-walks the chain (tamper check)
```

The browser also keeps the incident in `localStorage` and queues writes while offline, so the
app keeps working without connectivity and reconciles on reconnect.

## Deployment

One image, built in two stages (Vite SPA → `dist/`, then the FastAPI app that serves it),
running next to PostgreSQL; an optional Caddy container terminates TLS. Runs on Railway or
self-hosted via docker-compose. Full guide in [`DEPLOYMENT.md`](DEPLOYMENT.md).

```mermaid
flowchart LR
  USER["Operator (browser)"]
  CADDY["Caddy (optional)<br/>auto-HTTPS"]
  APP["app container<br/>uvicorn — FastAPI + built SPA"]
  PG[("postgres:16<br/>pgdata volume")]
  VOL[("storage volume<br/>media · plans · reference data")]
  USER --> CADDY --> APP
  USER -->|"plain HTTP / LAN"| APP
  APP --> PG
  APP --- VOL
```

## Why it's shaped this way

- **Single service, same-origin** → no CORS, cookies stay httpOnly/SameSite, one thing to
  deploy and back up.
- **Single-tenant (one deployment per station)** → data isolation is trivial; config is one row.
- **Backend is the only egress** → external API credentials never touch the browser, and every
  outbound call is SSRF-guarded and cacheable.
- **Append-only, hash-chained history** → the incident record is tamper-evident and replayable,
  suitable as a legal record.
- **Bundle nothing station-specific** → clean open-source posture; each station brings its own
  branding, config, and geodata.
