# kp-front backend

Standalone **FastAPI + PostgreSQL** backend (uv-managed) for the kp-front operational
Lagekarte. In production a single service serves both the built SPA and the API from one
origin (SameSite=Lax cookies, zero CORS).

## Layout
```
app/
  main.py            app wiring + lifespan (seed, blocklist cleanup, Divera scheduler)
  config.py          pydantic-settings (SECRET_KEY peppers PINs and signs JWTs)
  database.py        async SQLAlchemy engine/session
  models.py          all tables (Phases 1–7 + audit substrate)
  schemas.py         pydantic request/response models
  auth/              PIN-kiosk auth: peppered bcrypt, JWT cookies, JTI blocklist, cooldown
  api/               routers: incidents, media, events, divera, traccar, reference, objects
  audit.py           hash-chained event append + workspace snapshots + chain verify
  divera.py          keyword maps + alarm parsing + pool upsert
  traccar.py         Traccar client (knots→km/h, frontend-compatible shape)
  geocode.py         swisstopo geocoder
  storage.py         object storage (local dir v1 = Railway volume)
  seed.py            seed users from seed_users.json
  seed_reference.py  seed the global symbol pack (symbols:tactical) from ../../public
alembic/             migrations
tests/               pytest suite (see Tests below) + smoke_*.py scripts for a live server
```

## Local dev
```bash
# 1. Postgres (any instance; the .env below expects port 5434)
docker run -d --name kpfront-db-dev -e POSTGRES_USER=kpfront \
  -e POSTGRES_PASSWORD=kpfront -e POSTGRES_DB=kpfront -p 5434:5432 postgres:16-alpine

# 2. Configure + install
cp .env.example .env        # set a stable SECRET_KEY for dev (see note below)
uv sync --extra dev

# 3. Migrate + run
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
```
The Vite dev server (`pnpm dev`, :5188) proxies `/api` to :8000, so run both.

> **SECRET_KEY note:** it peppers PINs *and* signs JWTs. Keep it stable in dev — changing
> it invalidates already-seeded PIN hashes. Auto-generated (and printed) if empty, but then
> it changes every restart, so set a fixed value in `.env`.

## Seeding
- **Users:** `app/seed_users.json` (display_name, role, 6-digit PIN) — default user `fu`
  (Führungsunterstützung), role `editor`, PIN `000000`. Edit before first run; PIN reset is
  admin/CLI only. `uv run python -m app.seed`.
- **Reference data:** seeds only the global symbol pack (`symbols:tactical`, from
  `public/tactical-symbols.json`). Station data — geodata, object plans, checklists — is
  never seeded from the repo; load it per deployment via the `admin_*` CLIs or
  `just demo-load`. `uv run python -m app.seed_reference`.
- Both run automatically on startup when `SEED_DATABASE=true` (idempotent).

## Tests
`uv run pytest` needs **no database**: `tests/conftest.py` runs against `DATABASE_URL` when
set (CI provides a postgres:16 service) and otherwise falls back to an ephemeral in-memory
SQLite.

## Fake scenarios for testing (`fake_scenario`)

Inject realistic external inputs — Divera alarms, group/vehicle milestone times, Traccar
positions — into a running deployment through the same public webhooks production uses,
backdated so everything reads like a just-happened Einsatz. Taking the alarm, Anwesenheit,
Mittel and Journal stay manual in the app (exercising them is part of the test). Scenario
files live in `examples/scenarios/`; times are offsets like `"-25m"` relative to run time.

```bash
uv run python -m app.fake_scenario example                       # print a starter scenario
uv run python -m app.fake_scenario config                        # target's group/vehicle ids
uv run python -m app.fake_scenario run ../examples/scenarios/zimmerbrand.json
```

Targets `--base` / `KP_BASE_URL` (default `http://localhost:8001`); secrets default to the
local `.env`. Alarms need `DIVERA_WEBHOOK_SECRET`, milestone times `ALARM_WEBHOOK_SECRET`
(the CLI retries them until you take the alarm in the app — same contract as fwo-divera),
and vehicle positions need `TRACCAR_FAKE=1` on the server (`POST /api/traccar/fake`;
fail-closed, never set in the field — the map would show the fake fleet).

## Production (Railway, single service)
Build via the repo-root `Dockerfile` (builds the SPA, then runs this backend serving it).
Required env: `DATABASE_URL`, `SECRET_KEY` (`openssl rand -hex 32`). Optional: Divera
(`DIVERA_ACCESS_KEY`, `DIVERA_WEBHOOK_SECRET`), Traccar (`TRACCAR_URL/EMAIL/PASSWORD`),
`MEDIA_STORAGE_DIR` (Railway volume, default `/mnt/data/storage`). `RAILWAY_ENVIRONMENT`
forces Secure cookies and disables dev table-creation (Alembic owns the schema).
```

## Migrations
```bash
uv run alembic revision --autogenerate -m "describe change"
uv run alembic upgrade head
```

## Load Einsatzobjekte + Modul-PDFs (`admin_objects`)

Einsatzobjekte are **station data** — they don't live here. The station-specific importer
(walks the OneDrive `Einsatzpläne` library, geocodes, writes an `objects.manifest.json` +
`plans/` PDF folder) lives in the **private data repo** (`kp-front-data`,
`scripts/import_einsatzplaene.py`). This repo only ships the generic ingestion CLI,
`app.admin_objects` — the objects twin of `app.admin_geodata`.

```bash
uv run python -m app.admin_objects schema                 # the manifest contract
uv run python -m app.admin_objects example                # a populated example manifest
uv run python -m app.admin_objects validate <manifest>    # parse + check every PDF exists (no DB)
uv run python -m app.admin_objects load <manifest>        # upsert objects + copy PDFs (writes DB + storage)
uv run python -m app.admin_objects push <manifest> --base <url> --user-id <id> --pin <pin>   # → running deployment
uv run python -m app.admin_objects show                   # list stored objects + plan counts
```

Each object becomes an `ObjectSite` row and each Modul-PDF a `ReferenceDataset`
(`plan:<obj>:<module>`, blob in object storage), auto-surfaced on a nearby incident.
`load` writes the local storage volume (run it server-side); `push` goes through a running
server's API so it writes its OWN volume — the way to **refresh a remote deployment** from a
workstation. To refresh: re-run the importer in the data repo, then `just push-objects` (or the
`push` command above). See [`../docs/objektplaene-architecture.md`](../docs/objektplaene-architecture.md).

