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
  api/               routers: incidents, journal, alarms, capture, media, events, divera,
                     traccar, geocode, reference, objects, report, print_relay, push, stats,
                     personnel, admin, …
  audit.py           hash-chained event append + workspace snapshots + chain verify
  divera.py          keyword maps + alarm parsing + pool upsert
  traccar.py         Traccar client (knots→km/h, frontend-compatible shape)
  geocode.py         swisstopo geocoder
  storage.py         object storage (local dir v1 = Railway volume)
  seed.py            seed users from seed_users.json
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
uv run uvicorn app.main:app --reload --port 8001
```
The Vite dev server (:5188) proxies `/api` to this backend, so run both – `just dev` from the
repo root does the whole thing (Postgres + backend + frontend) in one terminal. Port 8001, not
8000: the latter is usually taken by a local kp-rueck.

> **SECRET_KEY note:** it peppers PINs *and* signs JWTs. Keep it stable in dev – changing
> it invalidates already-seeded PIN hashes. Auto-generated (and printed) if empty, but then
> it changes every restart, so set a fixed value in `.env`.

## Seeding
- **Users:** `app/seed_users.json` (display_name, role, 6–12-digit PIN) – default user `fu`
  (Führungsunterstützung), role `editor`. The file's `000000` is used in DEVELOPMENT only:
  in production `SEED_PIN` is required and the seeding raises without it, which now aborts the
  boot rather than leaving a deployment with no accounts (`app/main.py`). PIN reset is
  admin/CLI only. `uv run python -m app.seed`.
- **Reference data:** seeds only the global symbol pack (`symbols:tactical`, from
  `public/tactical-symbols.json`). Station data – geodata, object plans, checklists – is
  never seeded from the repo; load it per deployment via the `admin_*` CLIs or
  `just demo-load`.
- Both run automatically on startup when `SEED_DATABASE=true` (idempotent).

## Tests
`uv run pytest` needs **no database**: `tests/conftest.py` runs against `DATABASE_URL` when
set (CI provides a postgres:16 service) and otherwise falls back to an ephemeral in-memory
SQLite.

## Fake scenarios for testing (`fake_scenario`)

Inject realistic external inputs – Divera alarms, group/vehicle milestone times, Traccar
positions – into a running deployment through the same public webhooks production uses,
backdated so everything reads like a just-happened Einsatz. Taking the alarm, Anwesenheit,
Material and the Verlauf stay manual in the app (exercising them is part of the test). Scenario
files live in `examples/scenarios/`; times are offsets like `"-25m"` relative to run time.

```bash
uv run python -m app.fake_scenario example                       # print a starter scenario
uv run python -m app.fake_scenario config                        # target's group/vehicle ids
uv run python -m app.fake_scenario run ../examples/scenarios/zimmerbrand.json
```

Targets `--base` / `KP_BASE_URL` (default `http://localhost:8001`); secrets default to the
local `.env`. Alarms need `DIVERA_WEBHOOK_SECRET`, milestone times `ALARM_WEBHOOK_SECRET`
(the CLI retries them until you take the alarm in the app – same contract as fwo-divera),
and vehicle positions need `TRACCAR_FAKE=1` on the server (`POST /api/traccar/fake`;
fail-closed, never set in the field – the map would show the fake fleet).

## The post-Einsatz check (`admin_postcheck`)

Run it the morning after every Übung and every real alarm, **even if nobody complains**. The
post-mortem of the Übung on 23.09.2026 took a whole night of hand-written queries, and two of
its worst findings (a client clock that jumped back three days, and edits of other devices
being lost) had been reported by nobody. This command runs those queries the same way every
time.

```bash
uv run python -m app.admin_postcheck latest                        # the newest incident, DB only
uv run python -m app.admin_postcheck 3f2a9c1e --logs app.jsonl --http http.jsonl
uv run python -m app.admin_postcheck latest --json > check.json    # the same report as JSON
just postcheck latest --logs ~/pm/app.jsonl --http ~/pm/http.jsonl
```

The first argument is an incident id, a unique prefix of at least 8 characters, or `latest`.

**It never writes.** It opens its own connection (no pool) whose Postgres session starts with
`default_transaction_read_only = on`, sets it again, and reads it back before the first SELECT.
A connection that does not answer `on` is refused. To read production, use the public proxy URL
the way `just config-pull` does:
`DATABASE_URL=$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)`.

**Exit code:** `0` means no findings, `1` means findings (so a cron or CI job can tell), and `2`
means the check itself could not run. That includes a crash of the check, an unknown incident,
a dump table that is not a JSON array, and a log file with no usable line in the window. «OK»
has to mean that something was read.

**What was read.** With logs, the report opens with an *Inputs* block: per file, the lines read,
the lines usable, the lines in the window, and the time span the file covers. It warns when a
file has exactly 5000 lines (one Railway page, probably cut) or covers less than the window.
The summary line names every section it could not check, so a database-only run reads
`OK: no findings. Not checked: crashes (no --logs), http (no --http), auth (no --http).`,
not a plain «OK».

What it prints, one section each (times in UTC, with the date when the window spans days; a
finding line starts with `!`):

| Section | Reads | A finding is |
| --- | --- | --- |
| Devices seen | HTTP log: one device per User-Agent that touched this incident, with the IPs it used. That is a **lower bound**: two identical phones are one «device». When one User-Agent kept two Verlauf long-polls open at once, it prints «≥2 browsers behind D3». Without `--http`: the accounts in the audit log and a rough «several app sessions at once» estimate | – (information) |
| Crashes and render storms | `kpfront.clienterror` lines in the app log, grouped per device, message and build, with the `repeat=×N` counter added up. `render storm` and `surface-recrash` are marked. Crashes from browsers that never opened the incident (a boot crash loop) are listed as information | every group |
| HTTP errors (≥ 400) | the HTTP log, per device, status and endpoint. The 409s on `PUT …/workspace` per device, with their bursts and whether a save followed. 404s and 5xx from browsers that never opened the incident are listed as information | every group. The 409s count when one device has ≥ `--burst` (5) within any 60 s (a sliding window, not the clock minute), or a 409 that no save followed within 2 min. 401s go to the auth section; 499 (the app cancelled a long-poll) is not an error |
| Clock jumps | `journal_entries.row_json.at` against `created_at`, and a client audit event's `occurred_at` against `recorded_at`. Rows of the audio player (Durchhören, Nachdokumentation) are stamped when something was *said* and are skipped | more than `--clock-skew` (120 s) apart. With the HTTP log it says whether the device was online in between: then it was «probably its clock», not an offline queue |
| Duplicate events | the same audit event (op + payload), or the same Verlauf row (everything but `id`/`t`/`at`), under different ids within `--dup-window` (10 s). An observed event (`obs-<fact>@<actor>`) is once per actor by design, so two accounts each recording an alarm is not a duplicate | the same fact twice for one actor, or two copies under ordinary ids |
| PIN prompts and expired sessions | `/api/auth/*` and every 401 in the HTTP log, per device, grouped by minute | a login after the device had opened the incident (a PIN prompt mid-Einsatz), a failed refresh, a refused Einsatz-Link. A login *before* the device opens the incident is how it joins and is only listed, as is a silent renewal (401 answered by a successful refresh) |
| Vehicles | the «vor Ort / verlassen» Verlauf rows and the Rapport's Fahrzeugzeiten (`reportMeta.fahrzeuge`) against `vehicle_samples`. The presence state machine is replayed fix by fix (inside 150 m, beyond 300 m, the band between clears a pending change, 90 s to settle). The check first tells **which observer wrote the incident**: `vp-`/`e…` rows are the **client's** (a row per change, expected at GPS + 90 s); `vps-` rows or a `gps` block in `reportMeta.fahrzeuge` are the **server's** (a row stamped with the first fix in the zone, for the first arrival and the last departure only; trips in between counted in `gps.fahrten`); both at once is an incident spanning that deploy, and each row is judged by its own model | client model: a row more than `--vehicle-lag` (300 s) after the GPS, printed with the expected time, the stated and received time, and whether the writing device was online at the GPS change (late rows one device wrote in the same second are one finding); two rows for one change; a row with no GPS change behind it; a change with no row once a device had the incident open. Server model: a stamp more than 60 s off the first fix in its zone, a row for a trip in between, a first arrival without a row (unless the alarm gateway's geofence wrote «vor Ort» first), a last departure without a row once 20 min passed or the incident closed, and `gps.fahrten` differing from the stays on scene in the samples. A mixed incident judges rows but not missing rows; an incident with neither rows nor `gps` blocks judges nothing. An incident at 0/0 has no Einsatzort, and the section is skipped |

**Which device wrote a row.** A stored row carries the time its transaction *started*, and the
HTTP log carries the time the response left plus the request's duration. So the request that
stored a row began before it and answered after it (5 ms of slack for the two clocks, measured
on the Übung's data). Each request is matched to at most one batch of rows, in time order.
When two devices' appends queue on the incident row's lock, both requests cover both rows.
Each device still gets one row, but which is whose is unknown, and the report prints «D2|D5?».

### Getting the logs from Railway

Both logs come from the Railway CLI, per **deployment**. Find the id of the deployment that ran
during the Einsatz with `railway deployment list --service kp-front`. A replaced deployment's
logs are still served if you pass its id, and for `--http` also `--since`/`--until`. Without the
id you get the live deployment.

```bash
railway logs <deploymentId> --json --since 2026-09-23T17:00:00Z --until 2026-09-23T21:30:00Z --lines 5000 > app.jsonl
railway logs <deploymentId> --http --json --since 2026-09-23T17:00:00Z --until 2026-09-23T21:30:00Z --lines 5000 > http.jsonl
```

A call returns at most **5000 lines** (newest first, and a higher `--lines` is rejected). If a
file comes back with exactly 5000 lines, the window was too wide, and the check warns about it.
Page back with `--until` set to the oldest timestamp you have, or split the window until no
page is full, then concatenate the pages. Overlap does no harm: the check drops repeated HTTP
lines by `requestId` and repeated app-log lines by time and text. It reads the lines in the
window only (default: from 15 min before the alarm to 15 min after the close or the last
record; `--since`/`--until` override it). Railway logs a path without its query string, so a
Verlauf long-poll is recognised by its duration (≥ 5 s). Keep the files next to the post-mortem
(`docs/planning/postmortem-<date>-raw/`). They hold client IPs and user agents, so they stay
out of git.

A self-hosted station has no Railway HTTP log. `--logs` also reads plain `docker compose logs -t`
output (the first ISO timestamp on a line is its time), but `--http` needs Railway's JSON, so
there the device, HTTP and auth sections are skipped, and the summary says so.

### Reading a dump instead of a database

`--dump <dir>` reads the incident's tables from JSON files instead of `DATABASE_URL`. Each table
is a JSON **array** of row objects, as a post-mortem saves them (`json.dumps` of the SELECTs):
`journal_entries.json` (or `journal.json`), `incident_events.json` (or `events.json`),
`vehicle_samples.json`, `workspace.json` (`incidents.map_workspace_json`, an object). Optional:
- `incident.json`, the incident row (title, start, coordinates);
- `users.json` (id, role);
- `config.json`, the deployment config as `admin_config show` prints it. It names the fleet, so
  the Zeiten grid's ids can be compared with the GPS vehicles; without it the check says so and
  compares the ids as they are.

Without the incident row, pass the Einsatzort as `--center LAT,LNG`. This reproduces the
post-mortem of 23.09.2026 from its raw dumps without touching production.

## Production (Railway, single service)
Build via the repo-root `Dockerfile` (builds the SPA, then runs this backend serving it).

**Required env – all four**, and the last two are the ones people leave out:

| Variable | Why it is required |
| --- | --- |
| `DATABASE_URL` | the database |
| `SECRET_KEY` | `openssl rand -hex 32`; production refuses to boot without it (`config.py` · `_secret`) |
| `SEED_PIN` | 6–12 digits; production refuses to boot while `SEED_DATABASE` is on, because the seed file's PIN is public (`seed.py` · `resolve_seed_pin`). Missing it is a restart loop, not a warning |
| `ADMIN_SECRET` | `openssl rand -hex 24`; empty = the whole `/admin` surface answers 403, fail-closed, and nothing says so |

Optional: Divera (`DIVERA_ACCESS_KEY`, `DIVERA_WEBHOOK_SECRET`), Traccar
(`TRACCAR_URL/EMAIL/PASSWORD`), `MEDIA_STORAGE_DIR` (default `/mnt/data/storage`, baked into the
image – the Railway **volume must be mounted at `/mnt/data`**). `RAILWAY_ENVIRONMENT`
forces Secure cookies and disables dev table-creation (Alembic owns the schema).

The step-by-step Railway procedure – volume, `RAILWAY_RUN_UID=0`, variables, verification – is
[`../docs/DEPLOYMENT.md` §3a](../docs/DEPLOYMENT.md).

## Migrations
```bash
uv run alembic revision --autogenerate -m "describe change"
uv run alembic upgrade head
```

## Load Einsatzobjekte + Modul-PDFs (`admin_objects`)

Einsatzobjekte are **station data** – they don't live here. The station-specific importer
(walks the OneDrive `Einsatzpläne` library, geocodes, writes an `objects.manifest.json` +
`plans/` PDF folder) lives in the **private data repo** (`kp-front-data`,
`scripts/import_einsatzplaene.py`). This repo only ships the generic ingestion CLI,
`app.admin_objects` – the objects twin of `app.admin_geodata`.

```bash
uv run python -m app.admin_objects schema                 # the manifest contract
uv run python -m app.admin_objects example                # a populated example manifest
uv run python -m app.admin_objects validate <manifest>    # parse + check every PDF exists (no DB)
uv run python -m app.admin_objects load <manifest>        # upsert objects + copy PDFs (writes DB + storage)
uv run python -m app.admin_objects push <manifest> --base <url> --admin-secret <ADMIN_SECRET>  # → running deployment
uv run python -m app.admin_objects show                   # list stored objects + plan counts
```

Every object needs a **stable** key, because that is what makes a rerun *update* the object
instead of creating a second one. Give it as `"key": "schulhaus-dorfmatt"` – a short name you
can retype next year, hashed to a fixed uuid5 – or, for manifests the private importer writes,
as the explicit `"id"` UUID it derived. Never invent a UUID by hand.

`load` and `push` always report what they did: which objects were created, which were updated,
how many plan PDFs were attached, and – by name – any plan that did **not** land. A push that
could not attach a plan exits non-zero.

Each object becomes an `ObjectSite` row and each Modul-PDF a `ReferenceDataset`
(`plan:<obj>:<module>`, blob in object storage), auto-surfaced on a nearby incident.
`load` writes the local storage volume (run it server-side); `push` goes through a running
server's API so it writes its OWN volume – the way to **refresh a remote deployment** from a
workstation. To refresh: re-run the importer in the data repo, then `just push-objects` (or the
`push` command above). See [`../docs/objektplaene-architecture.md`](../docs/objektplaene-architecture.md).

