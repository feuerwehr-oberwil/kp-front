# DEPLOYMENT – self-hosting KP Front

**Status:** Two supported paths, both tested: **docker-compose on a VPS** (§3) and
**Railway** (`railway.json` + the repo Dockerfile – §3a). Same image, same
auto-migrate-on-boot behaviour – pick by who runs the server. Decisions it encodes: Docker,
auto-migrate on boot (D8), local-volume storage (D10), one-instance-per-station (D3),
individual accounts (D5).

> **On Railway, read [§3a](#3a-railway-in-order) before you deploy anything.** Two of the
> platform's defaults are wrong for this image – the volume mount path and the container user –
> and both fail *before* the app serves a single request, so no screen this app owns can tell
> you about it. §3a is the procedure in order; everything from §4 onwards applies to both paths.

---

## 1. What you're deploying

One **deployment = one fire station** with its own database – no shared multi-tenancy. The
stack:

```
┌──────────┐   ┌─────────────────┐   ┌────────────┐
│ frontend │ → │ backend (API)   │ → │ Postgres   │
│ (static) │   │ FastAPI         │   │            │
└──────────┘   │ + asset storage │   └────────────┘
               │ (local volume)  │
               └─────────────────┘
```

Plus optional external services you bring credentials for: Divera (alarms/roster), Traccar
(live vehicle GPS). Base maps, weather, and the geocoder are public swisstopo/MeteoSwiss
services – no credentials.

## 2. Requirements

### What machine

One station, one box. The stack is two containers – the app image (the SPA and its API in one
process) plus Postgres – with Caddy as an optional third.

| | Minimum | Recommended |
| --- | --- | --- |
| CPU | 1 core, x86-64 or arm64 | 2 cores |
| RAM | **1 GB** | **2 GB** |
| Disk | 20 GB **SSD** | 64 GB SSD, more if you upload many plans |
| OS | anything with Docker Engine + Compose v2 | Debian 12/13 |

**Both architectures are published:** the image is built for `linux/amd64` and `linux/arm64`,
so a small VPS, a mini PC, a retired laptop or a Raspberry Pi 5 all work. 32-bit ARM (armv7 –
a Raspberry Pi 3, or a Pi 4 running a 32-bit OS) is **not** built and will not run; on a Pi,
install a 64-bit OS.

The app process and an idle Postgres together sit comfortably under 500 MB, which is why 1 GB
is a genuine minimum. What grows is **uploaded plans and incident media** in the `storage`
volume – size the disk from that, not from the application.

**Use an SSD, and do not run this from a microSD card or a USB stick.** Postgres writes
continuously even when nobody is using the app, and cheap flash fails by silent corruption
rather than by stopping. If the box lives in the Gerätehaus, put it on a UPS.

### HTTPS is not optional here

For HTTPS: a domain pointed at the host. The bundled **`tls` profile runs Caddy** and gets a
certificate automatically (Let's Encrypt / ZeroSSL) – no manual cert work. Or front it with
your own reverse proxy / Traefik.

Plain HTTP over the LAN is **not** an equivalent fallback for this application. KP Front is a
PWA, and four of its features exist only in a browser "secure context": the **service worker**
(offline cache), **web push** (alerts when the app is closed), **geolocation**, and
**microphone access** for voice memos. Deploy it on `http://10.x.x.x` and all four are gone
silently – on the application whose whole purpose is bad connectivity. If the host has no
public address, use a DNS-01 certificate for an internal name, or Caddy's `tls internal` and
install the root certificate on every device (on iOS that is two steps: install the profile,
*then* enable it under General → About → Certificate Trust Settings).

### Database

Postgres: **bundled in the compose file** (the `db` service), or point `DATABASE_URL` at a
managed Postgres and drop the `db` service.

## 3. Quick start (self-host)

Everything ships in the repo root: `docker-compose.yml`, `.env.example`, `deploy/Caddyfile`.

```bash
# 1. Get the compose file + templates (a tagged release is the safe choice, not main)
git clone https://github.com/feuerwehr-oberwil/kp-front.git && cd kp-front
git checkout "$(git tag -l 'v*' --sort=-v:refname | head -n1)"   # newest release; pick an older tag if you prefer

# 2. Configure secrets. Use the script – it generates all FOUR required values, and the
#    fourth (SEED_PIN) is the one people miss. Plain bash + docker: a station server needs
#    no `just`, no `uv`, no `pnpm`:
./scripts/init-env.sh       # POSTGRES_PASSWORD + SECRET_KEY + ADMIN_SECRET + SEED_PIN
#                           # note down the ADMIN_SECRET and SEED_PIN it prints – nothing shows them again
#    …or ./scripts/setup.sh, which asks for the domain, the port and whether to schedule
#    nightly backups, decides COOKIE_SECURE, APP_BIND, the tls profile and KP_FRONT_TAG from
#    the answers, starts the stack, and then mints the Web Push pair into the encrypted
#    credential store (never into .env, which would lock it in /admin). Webhook secrets are
#    chosen when the external alarm system is connected – SETUP.md §1.

# 3a. Plain HTTP on APP_PORT (LAN / behind your own proxy). Pull + migrate + seed on boot (D8):
docker compose up -d
#     On a trusted LAN with no TLS, set COOKIE_SECURE=false in .env so login cookies work.
#     Port already taken? See "APP_PORT and APP_BIND" below.

# 3b. …or automatic HTTPS on a public domain (set DOMAIN in .env first):
docker compose --profile tls up -d
#     Also set APP_BIND=127.0.0.1 – see below.

# 4. The first incident editor account is seeded from backend/app/seed_users.json on
#    first boot: user "fu" (Führungsunterstützung), stored role editor. Its PIN is the
#    SEED_PIN from your .env – in production the backend REFUSES to fall back to the seed
#    file's public 000000. Change the PIN after first login.
```

> **⚠️ Filling `.env` in by hand: `SEED_PIN` is required, and forgetting it is not a soft
> failure.** `cp .env.example .env` copies four empty Required values, and every one of them
> has to be filled: `POSTGRES_PASSWORD`, `SECRET_KEY` (`openssl rand -hex 32` – keep it
> **stable**, it signs JWTs and peppers PINs), `ADMIN_SECRET` (`openssl rand -hex 24`; empty =
> `/admin` disabled), and **`SEED_PIN`** (six digits, not 000000/123456).
>
> Leave `SEED_PIN` empty and nobody can log in – **in one of two shapes**, depending on which
> image you run: current releases restart-loop (§8), while the old **v0.6.0** image came up
> green with an empty roster. Both shapes, and the one fix, are in
> [`SETUP.md` §1](SETUP.md).
>
> `KP_FRONT_TAG` (which release to run, default `latest` – §5) and the rest are optional; see §4
> and `CONFIGURATION.md §6`. **`./scripts/init-env.sh` fills all four and refuses to clobber an
> existing `.env`, which is why it is the recommended path** – or `./scripts/setup.sh`, which
> runs the same code and then decides the networking questions with you.

> **Production hardening is automatic** under compose: the app runs with `ENVIRONMENT=production`,
> which makes `SECRET_KEY` mandatory (no silent per-restart rotation), enables Secure cookies
> (unless you opt out with `COOKIE_SECURE=false`), and hands schema ownership to Alembic.

### `APP_PORT` and `APP_BIND`

Two host-level settings that a fresh install runs into immediately:

- **`APP_PORT` (default 8000) must be free on the host.** If anything else already listens
  there – a KP Rück stack, another compose project, a dev server – `docker compose up -d` stops
  with `Bind for 0.0.0.0:8000 failed: port is already allocated`. Nothing is broken: check with
  `ss -tlnp | grep :8000`, set another port in `.env` (`APP_PORT=8100`), and run it again. Two KP
  stacks on one host need two different `APP_PORT`s (and only one of them can own 443 – see
  kp-rueck's `RUNNING-BOTH.md`).
- **`APP_BIND` (default `0.0.0.0`) decides who can reach that port.** Docker publishes ports via
  its own NAT rules, which are consulted *before* `ufw`'s – `ufw deny 8000` does **not** close a
  published port. `APP_BIND` is the knob that does.

| Deployment shape | `APP_BIND` | Why |
| --- | --- | --- |
| Plain HTTP on a trusted LAN (3a) | `0.0.0.0` | the tablets have to reach it |
| `--profile tls`, Caddy in front (3b) | `127.0.0.1` | Caddy reaches the app over the compose network, not through this port – without it the app is served in **plaintext straight past the TLS you just set up** |
| Your own reverse proxy on the same host | `127.0.0.1` | same reason |
| Reverse proxy on a *different* host | `0.0.0.0` | plus a firewall rule at the cloud provider, not `ufw` |

### Published images vs. building from source
The compose file **pulls a published image** –
`ghcr.io/feuerwehr-oberwil/kp-front:${KP_FRONT_TAG:-latest}` (`linux/amd64` and `linux/arm64`,
so an ARM host is a real option) – so a station VPS needs nothing but Docker: no Node, no uv, no
build step. Every `v*` tag is built, booted and smoke-tested by CI before it is pushed
(`.github/workflows/release.yml`), and the same gate runs on every commit to `main`, so a
Dockerfile regression can't reach a release.

> Releases predating the arm64 build are **amd64 only** – see the `Added` entry in
> [`CHANGELOG.md`](../CHANGELOG.md). On an ARM machine those pull with
> `no matching manifest for linux/arm64/v8`; run them with
> `DOCKER_DEFAULT_PLATFORM=linux/amd64` under emulation, or take a newer release.

Pick what `KP_FRONT_TAG` follows, in `.env`:

| Value | Follows | For |
| --- | --- | --- |
| `X.Y.Z` (a full version) | nothing – exactly this build | production stations that update deliberately |
| `X.Y` (a series) | patch releases in that series | stations that want fixes but not features |
| `latest` (default) | every release | evaluation, demo instances |

Which versions exist is the [releases page](https://github.com/feuerwehr-oberwil/kp-front/releases);
`latest` is the newest *release*, never `main`.

**To build from source instead** (contributors, or a patched fork), keep the tracked compose
file unchanged and install its gitignored override:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  docker compose up -d --build
```

`./scripts/setup.sh --build` performs the same setup. Rebuild after each `git pull`; without
`--build`, Compose keeps running the previous local image.

Then open the app and **log in by picking your name + PIN**. For station setup, **start in the
browser**: making the deployment yours – name, colours, logo, doctrine, accounts, crew, vehicles,
map layers, object plans, checklists and every integration key – is forms at `/admin`, and a
station can run its whole life that way (`SETUP.md` §3). The CLIs in `CONFIGURATION.md`
(`admin_config`, `admin_geodata`, `admin_objects`, …) are the same rows as a file, for a
configuration you want reviewable, versioned or reproducible on a second deployment, and for
loading a whole library rather than one item at a time. There is **no setup
wizard** (D7). Incident roles are `editor`/`viewer`
(renamed from the legacy `commander` value 2026-06-30). Deployment administration is **separate
from the incident role**: the `/admin` UI and admin-write API/CLI are unlocked with the
**`ADMIN_SECRET`** env var (not the editor PIN). If `ADMIN_SECRET` is unset the admin surface is
disabled (fail-closed), so set it before you need to administer the station.

## 3a. Railway, in order

The other supported path. Railway builds this repository's `Dockerfile` and runs **one** service;
the database and the asset volume are the platform's. Same image, same auto-migrate-on-boot, same
one-station shape – `docker-compose.yml`, `.env` and `scripts/setup.sh` are the compose path only
and Railway users can ignore all three. What is different is that two platform defaults do not fit
this image, and both fail *before* uvicorn binds, so there is no `/ready`, no log page in the app
and no error screen – only a service that keeps restarting.

Do it in this order. Steps 3 and 4 are the ones people discover afterwards.

1. **Create the service from the repository.** New project → *Deploy from GitHub repo* (or
   `railway init` and `railway up` from a checkout). The committed `railway.json` already sets the
   builder, the healthcheck and the restart policy – see *What `railway.json` sets* below. The one
   thing it deliberately leaves to you is the **region**; pick it on the service.
2. **Add Postgres to the same project** (New → *Database* → *PostgreSQL*) and reference it from the
   app service: `DATABASE_URL=${{Postgres.DATABASE_URL}}`. There is no bundled `db` service here.
3. **Attach a volume and mount it at `/mnt/data`.** Not optional, and not `/data`: the image bakes
   `MEDIA_STORAGE_DIR=/mnt/data/storage` (`Dockerfile`), and that one directory holds the uploaded
   plan PDFs, incident photos and voice memos, the reference blobs **and** the pre-migration dumps
   (§5). Mounted anywhere else, the app writes into the container filesystem, which the next deploy
   throws away.
4. **Set `RAILWAY_RUN_UID=0` on the service, before the first deploy.**

   ```bash
   railway variable set RAILWAY_RUN_UID=0 --service <app-service>
   ```

   The image runs as uid 10001 (`Dockerfile` · `USER app`), and Railway mounts volumes
   **root-owned**. The Dockerfile pre-creates `/mnt/data/storage` owned by the app user precisely
   so an *empty* volume inherits that ownership, but Railway's mount lands on top of it, so the
   app user cannot create a thing under `/mnt/data`. `RAILWAY_RUN_UID=0` is the documented
   platform override that runs the container as root there; compose self-hosters keep the non-root
   user and need none of this.

   > ⚠️ **What this looks like when it is missing is a crash loop with no HTTP surface at all** –
   > not a `/ready` that reports storage as broken. On a fresh database every migration is pending,
   > so `backend/start.sh` enters the pre-migration-dump branch, tries `mkdir -p
   > /mnt/data/storage/backups` as uid 10001, fails on the root-owned mount, and **aborts the boot
   > deliberately** («cannot create backup dir …») rather than migrating an un-backed-up database.
   > That happens before `exec uvicorn`, so nothing ever listens, the healthcheck has nothing to
   > probe, and the deploy dies on `healthcheckTimeout`. The reason is one line in the **deploy
   > logs** and nowhere else. The restart-branch symptom – a running app whose `/ready` reports
   > `storage: error` – is the *other* shape of the same cause, and it only appears once there is
   > nothing left to migrate.
   >
   > `ALLOW_MIGRATION_WITHOUT_BACKUP=1` silences the abort and is the wrong fix here: it trades a
   > loud first boot for a station that has no media storage and no migration safety net. Fix the
   > mount and the uid.
5. **Set the variables.** Four are required – the same four the compose path generates into `.env`,
   for the same reasons – and Railway counts as production (auto-detected from its own injected
   variables, `backend/app/config.py` · `is_production`), so the two production rules apply
   in full: `SECRET_KEY` is mandatory and `SEED_PIN` is mandatory while seeding is on.

   | Variable | Value | Missing it means |
   | --- | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | no database, nothing boots |
   | `SECRET_KEY` | `openssl rand -hex 32` | **refuses to boot.** Keep it stable – it signs JWTs, peppers PINs and seals the credential store (§6) |
   | `SEED_PIN` | six digits, not `000000`/`123456` | **refuses to boot** while `SEED_DATABASE` is on (the seed file's PIN is public) |
   | `ADMIN_SECRET` | `openssl rand -hex 24` | everything runs and `/admin` is disabled, fail-closed, with nothing saying so |

   ```bash
   railway variable set SECRET_KEY="$(openssl rand -hex 32)" --service <app-service>
   railway variable set ADMIN_SECRET="$(openssl rand -hex 24)" --service <app-service>
   railway variable set SEED_PIN=<six digits> --service <app-service>
   ```

   Nothing else is required. `PORT` is injected by Railway and read by `start.sh`;
   `ENVIRONMENT`/`APP_ENV` are unnecessary because Railway is detected; `MEDIA_STORAGE_DIR` is
   already correct as long as step 3 was done. Optional but usually wanted: `PUBLIC_URL` (the
   deployment's public origin, so outbound webhooks can carry absolute links). **Integration
   credentials do not belong here** – Divera, Traccar, Web Push, STT, CARTO, the webhook secrets
   and the monitor ping go into `/admin` → Zugangsdaten, encrypted in the deployment's own
   database and changeable without a redeploy (§4).

6. **Deploy, then verify two URLs, not one.**

   ```bash
   curl -s https://<service>.up.railway.app/ready          # {"status":"ok","database":"ok","storage":"ok"}
   curl -s https://<service>.up.railway.app/api/auth/roster # a non-empty list of accounts
   ```

   `/ready` green says the database is reachable and the volume is writable. It says **nothing**
   about whether anybody can log in – that is the roster, and an empty `[]` there means seeding
   never ran (§8 and [`SETUP.md` §1](SETUP.md)). Then open the app, log in as `fu` with your
   `SEED_PIN`, and continue at `/admin` exactly like a compose station ([`SETUP.md` §3](SETUP.md)).

> **What `railway.json` sets, and why** (2026-08-08, after a 25-minute outage on 0/1 replicas).
> `restartPolicyType: ALWAYS` – a station server has no successful exit, so a clean shutdown must
> be restarted too; `ON_FAILURE` only covers a crash and left production stopped. `numReplicas: 1`
> remains the supported topology: the local asset volume is not shared replica-safe. Scheduler jobs
> themselves are protected by a PostgreSQL advisory-lock leader; standby replicas retry every 10
> seconds and take over after the leader connection dies, so a transient overlap cannot double-fire
> Divera polling, push sweeps, resets or heartbeats. `sleepApplication: false` – an app that sleeps
> is an app that is not there when the pager goes off. `healthcheckTimeout: 300` because migrations
> run on boot and a long history needs the room. **`region` is deliberately not in the file** –
> that one is the deployer's choice, set it on the service.
>
> Two things no committed file can do for you: a Railway setting only takes effect **after the
> service redeploys**, and a restart policy nobody has tested is a belief – stop the container on
> a non-production service once and confirm it comes back by itself.

⚠️ **A failed Railway healthcheck does not keep the previous deployment serving.** Treat any deploy
that changes the runtime user, the volume mount or the healthcheck as a maintenance window. And on
Railway the database is managed, so the backup story is §6's Railway paragraph – scheduled
`pg_dump` against `DATABASE_PUBLIC_URL` from a machine you control, plus the automatic
pre-migration dumps on the volume.

## 4. Configuration split

| What | Where | Who |
|------|-------|-----|
| Host + boot secrets | `.env` (env vars) | operator, at deploy time |
| Integration credentials | `/admin` → Zugangsdaten, encrypted in the DB – **or** `.env`, which wins | operator or technical deployment owner, any time |
| Station config + assets | forms at `/admin`, writing the DB/reference store directly; or a private config/data repo → CLI, for config as code | technical deployment owner |
| Per-incident settings | in-app | any user, during an incident |

Full env reference: `.env.example` (compose) and `CONFIGURATION.md §6` – plus §6b for the tokens
that look like env vars and are not (Erfassungs-Poster, Statistik-Export, Einsatz-Link). Minimum to boot via
compose: `POSTGRES_PASSWORD` + `SECRET_KEY` (≥32 chars) + `SEED_PIN` (six digits – without it
nobody can log in, see §3); `DATABASE_URL` is assembled from the Postgres vars
automatically. For a managed Postgres, set `DATABASE_URL` directly instead. Set `ADMIN_SECRET`
(≥16 chars) too, or the `/admin` surface stays disabled – so four values, all four generated by
`./scripts/init-env.sh`.

### Integration credentials are no longer an `.env`-only story

Seventeen of the optional variables in `.env.example` – every Divera, Traccar, Web Push,
speech-to-text and webhook setting, plus `CARTO_API_KEY`, `PRINT_AGENT_SECRET` and
`HEALTHCHECK_PING_URL` – can
instead be set at `/admin` → **Zugangsdaten**, stored encrypted in this deployment's own database
and applied **without a restart**. `SETUP.md` §5 is the operator's version, including which
variables deliberately stay env-only and why; `API.md` has the endpoints.

Three things that matter at deploy time:

- **`.env` still wins, so an existing deployment changes behaviour not at all.** A variable with
  a value in the file is what every consumer gets, and its browser field then reports itself as
  server-set and refuses to save (409). Filling a line in is how you deliberately keep a value out
  of the admin UI's reach; leaving one blank is not "off", it is "whoever administers this station
  decides".
- **`./scripts/setup.sh` mints the VAPID pair into that store**, not into `.env` (`SETUP.md` §1).
  `./scripts/setup.sh --credentials` re-runs that one step against an already-installed
  deployment. Webhook secrets are set when the external alarm system is connected because they
  are write-only and the same freshly chosen value must be given to both sides.
- **Rotating `SECRET_KEY` makes every stored credential unreadable** on top of breaking every
  PIN – §6.

### Running the CLIs on a host that has only Docker

The `admin_*` CLIs and `gen_vapid` are usually described as `cd backend && uv run python -m …`,
which needs the `uv` toolchain and a checkout. **On the server you need neither** – the runtime
image *is* a `uv` image with the backend installed in it and `DATABASE_URL` already in its
environment, so the same commands run inside the container that is already there:

```bash
docker compose exec app uv run python -m app.gen_vapid          # a VAPID pair, no toolchain
docker compose exec app uv run python -m app.admin_config show      # what this deployment holds
docker compose exec app uv run python -m app.admin_config history   # …and what it replaced
docker compose exec app uv run python -m app.admin_config restore <id>
docker compose exec app uv run python -m app.admin_objects show
docker compose exec app uv run python -m app.admin_geodata show
```

This is the whole diagnostic and generation half of `CONFIGURATION.md`, on a station server
with nothing installed but Docker.

⚠️ **What this does *not* cover is `load` / `push` of your own files.** Those read a manifest
and the PDFs, GeoJSON or JSON it points at, and those files are on *your* machine, not in the
container – so config-as-code still means `uv` on a workstation (`SETUP.md` §3). The dividing
line is simple: reading and generating works in the container; publishing something you wrote
does not.

## 5. Updating

```bash
docker compose pull
docker compose up -d                  # add --profile tls if you run Caddy
```
Pinned to a specific version? Edit `KP_FRONT_TAG` in `.env` first, then run the two commands.
Release notes: <https://github.com/feuerwehr-oberwil/kp-front/releases>.

**What the version number tells you** (see `CHANGELOG.md` for the full table): a **PATCH** bump
is fixes only and always safe; a **MINOR** bump adds features and migrates automatically; a
**MAJOR** bump needs you to read the notes first, because something requires operator action.

- The new image carries its DB migrations; **they run automatically on boot** (D8, via
  `start.sh` → `alembic upgrade head`). When a migration is actually pending, `start.sh`
  first writes a **pre-migration dump** to `<MEDIA_STORAGE_DIR>/backups/pre-migrate-*.sql.gz`
  (newest 5 kept), so a bad migration is recoverable even without external backups.
  **This is not best-effort: if the dump cannot be written, the boot is refused** rather than
  migrating an un-backed-up database. The usual causes are a root-owned volume and a `pg_dump`
  older than the server (the client major is baked into the image; a managed host that upgraded
  Postgres under you does this). The container will say which. Override with
  `ALLOW_MIGRATION_WITHOUT_BACKUP=1` only when you have a backup by other means – and take one
  first (§6). ⚠️ On compose that variable has to be handed to the container on the command line;
  `docker-compose.yml` does not name it, so a line in `.env` reaches interpolation and nothing
  else:

  ```bash
  docker compose run --rm -e ALLOW_MIGRATION_WITHOUT_BACKUP=1 app   # same start.sh: migrates, then
                                                                    # serves in the foreground – Ctrl-C
  docker compose up -d                                              # …once the migration has landed
  ```

  On Railway it is an ordinary service variable – set it, deploy, then remove it again.
- **The whole batch of pending migrations runs in ONE transaction**, so there is no
  half-migrated schema to clean up: either they all land or none do.
- **Rollback:** set `KP_FRONT_TAG` to the previous version and re-run the two commands.
  Migrations are kept backward-safe within a minor series, so the prior image runs against the
  migrated schema.
- **Which build am I running?** `/admin` → System shows the version, commit and environment;
  the app menu carries the same stamp (`vX.Y.Z · <sha> · <date>`) on the tablet itself.
- **Postgres major upgrades** (e.g. 16→17) are *not* automatic – a 16 data volume won't be
  read by a 17 server. Stay on `postgres:16` for the life of the volume; to move majors, take a
  `pg_dump` (see §6), start a fresh volume on the new major, and restore.
- Watch the release notes for any breaking config changes.

## 5.5 Knowing when it is down

Nothing tells you by itself. `restart: unless-stopped` reacts to a container that *exits*, not
to one that is merely broken – an app answering 503 because its disk is full stays up and stays
wrong, and the compose healthcheck has no consumer that alerts anybody.

The app has a **dead-man's switch** built in and switched off. Point `HEALTHCHECK_PING_URL` at a
ping URL (healthchecks.io is free and enough) – at `/admin` → **Zugangsdaten**, where it takes
effect immediately, or in `.env`, which wins and locks the field (§4) – and it pings **every 60 s**
while it is alive (`backend/app/scheduler.py` – the heartbeat job is registered with `seconds=60`).
While it is unset it is also the «Überwachung» row on the «Einrichtung» card a fresh admin
lands on, so it is hard to leave undone by accident.
Configure the check to match: **period 1 min, grace ~3 min**, which alerts about four minutes
after the app goes quiet and still absorbs a single dropped ping (a failed ping is logged and
swallowed, so the next attempt is 60 s later). A longer period is not wrong, it just buys the
outage more time. When the pings stop, the monitor tells *you* – instead of an Einsatzleiter
telling you at 03:00, holding a tablet that shows a spinner.

Worth watching alongside it: **disk**. `/admin` → System reports storage use, and the volume is
shared by media, the reference blobs and the pre-migration dumps. A full volume flips `/ready`
to 503, which on compose does not restart anything.

## 6. Backups & data protection

- **Back up two things, together:** the Postgres database and the asset volume
  (`MEDIA_STORAGE_DIR`, the `storage` volume). A DB restored against an older/newer volume
  leaves media rows pointing at missing blobs – capture both at the same time.
- **`scripts/backup.sh` does both** (dump + volume tarball into one directory, with
  retention via `BACKUP_KEEP`, default 14 – settable in `.env`, which is the only place cron
  will ever see it). It writes **`db-<stamp>.sql.gz` and `storage-<stamp>.tar.gz`**; those two
  names are what `scripts/restore.sh` pairs up, so leave them alone.
- ⚠️ **Three things in `/admin` look like backups and are not.** The **Arbeitsmappe** `.xlsx` is
  list-shaped station data only – no config, no assets, no keys – and re-importing it restores
  none of the rest. **Sicherung → Export** and **«Letzte Änderungen»** cover the whole
  configuration document and every version of it that ever existed, which is the right tool for
  an admin who overwrote something, and no help at all for a dead disk: neither holds an incident,
  a photo, an audio note or a plan PDF. Only the pair above does.

### The schedule

`./scripts/setup.sh` **offers** to install it during a first install, and will install it on
its own against an existing deployment:

```bash
./scripts/setup.sh --backup-cron        # adds the line, then runs it once to prove it works
```

It adds one line to the invoking user's crontab, and then runs that exact command under
`env -i` – cron's near-empty environment – because **`docker: command not found` at 03:30, into
a log nobody reads, is the usual reason a backup job turns out never to have run**.

⚠️ **The proof run only happens for a line the script installed.** It first checks whether this
user's crontab already mentions `scripts/backup.sh`; if it does – including the hand-pasted line
below – it reports «leaving it alone» and returns without testing anything. So the paste-it-
yourself route does **not** get the verification, and that is yours to do: run the line's own
command once under `env -i PATH=… HOME="$HOME"` before you rely on it, and check
`./scripts/doctor.sh` a day later.

If you prefer to paste it yourself, `crontab -e`:

```bash
# Daily at 03:30, keep two weeks. The PATH belongs ON THE JOB, not as a bare `PATH=` line in
# the crontab: a bare assignment is global to the file and silently overrides – or is
# overridden by – whatever else the operator keeps in there.
30 3 * * * cd /opt/kp-front && PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin ./scripts/backup.sh /var/backups/kp-front >> /var/backups/kp-front/backup.log 2>&1
```

The script reads `POSTGRES_USER` / `POSTGRES_DB` from the deployment's `.env` (not from the
calling shell), so a station that changed either one is backed up correctly under cron too.
`./scripts/doctor.sh` reports whether a schedule exists **and** whether it has actually
produced a recent file – an installed line that has never written anything is not a backup.

```bash
# Manual equivalents (run with the stack up):
docker compose exec -T db pg_dump -U kpfront kpfront | gzip > db-$(date +%F).sql.gz
docker compose exec -T app tar czf - -C /data/storage . > storage-$(date +%F).tar.gz
```

### Restoring

**`scripts/restore.sh` is the procedure.** It restores the database and the storage volume
together, refuses half a pair, integrity-checks both archives *before* dropping anything,
takes a safety copy of what it is about to replace, and counts rows and files afterwards
rather than declaring success:

```bash
./scripts/restore.sh --dry-run backups/db-2026-08-15-033001.sql.gz   # always first
./scripts/restore.sh           backups/db-2026-08-15-033001.sql.gz   # type 'restore' to confirm
```

It finds `storage-<same stamp>.tar.gz` next to the dump by itself. `--db-only` restores a
database alone – that is for the **pre-migration dumps** (§5), which have no storage half; on
an ordinary backup it leaves you with rows pointing at the wrong blobs, and it says so.

> ⚠️ **Do not restore by piping a dump into `psql` on a stack that has booted.** The app runs
> its migrations on boot, so the database already has every table – and `psql` without
> `ON_ERROR_STOP` prints one "already exists" per object, carries on, and **exits 0** on a
> restore that put nothing back. `restore.sh` drops the schema first and stops at the first
> error, which is the difference between a restore and a mess.

- **Do one restore drill** into a fresh stack before relying on the files – the incident
  record is only provably recoverable once you've actually restored it. `--dry-run` is not the
  drill; it is the rehearsal for the drill.
- On **Railway** the database is managed – use scheduled `pg_dump` against
  `DATABASE_PUBLIC_URL` from a machine you control, plus the automatic pre-migration dumps
  on the volume (§5).
- Single-instance isolation means **all your station's data is in your DB** – strong story for
  cantonal data-protection. If you process personal/operational data, follow your canton's DSG
  guidance. Minimum operational stance for an internal station release: keep exports and database
  backups access-controlled, document who can restore them, and define how long incident records,
  roster data, GPS traces, uploaded plans, photos, and audio notes are retained.

### ⚠️ Back up `.env` somewhere else – `SECRET_KEY` is the key to two things

The dump and the volume tarball hold the data. They do **not** hold `.env`, and `SECRET_KEY` is
what makes the data usable:

- It **peppers every PIN hash.** Restore a database without the same `SECRET_KEY` and every
  account is locked out, with no way to tell that from "wrong PIN".
- It **derives the key every stored integration credential is encrypted under** (§4). Under a
  different `SECRET_KEY` those rows cannot be opened at all: Divera, Traccar, Web Push, STT, both
  webhook intakes and the monitor ping report themselves in «Zugangsdaten» as
  «unlesbar, bitte neu setzen» and stay off until somebody types each one in again. That is
  deliberately loud rather than silent – an undecryptable value is never shown as merely
  "not configured" – but it is still every integration down at once.

Which is the same never-rotate rule as always, with one more consequence attached. That
encryption is also why a stolen dump is worth less than it looks: the ciphertext is in the
backup and the key never is. Keep a copy of `.env` wherever you keep the ADMIN_SECRET – a
password manager, a sealed envelope in the Magazin – not only on the box the backups are
protecting.

## 7. "Can you host it for us?"

**Not today.** KP Front is self-hosted only: you run it, you own the data, and there is no
service to buy. Running one station needs a small VPS and the steps in `SETUP.md` – no build
toolchain, no ongoing maintenance beyond `docker compose pull` and a backup job.

If that is genuinely out of reach for your corps, say so in a
[discussion](https://github.com/feuerwehr-oberwil/kp-front/discussions). Whether a managed
offering is ever worth setting up depends on how many stations are in that position, and right
now we don't know.

## 8. Troubleshooting

**Start with `./scripts/doctor.sh`.** It is read-only – it starts nothing and writes nothing,
so it is safe to run during an incident – and it recognises the failures below by name: a port
collision, a restart loop, an unwritable volume, a dead database, a green stack with an empty
roster, a nearly full storage volume, and a backup schedule that is missing or has stopped
producing files. It prints the command that fixes what it finds. It is the same diagnosis
`setup.sh` gives on install day, which used to be the only day you could get it.

- **The `app` container restarts in a loop (`docker compose ps` shows it Restarting):** read the
  reason – it is in the logs, not on any screen the app serves.

  ```bash
  docker compose logs app | tail -n 40
  ```

  Most often on a first boot: **`SEED_PIN is required in production`**. Seeding runs before the
  app can serve anything (`backend/app/main.py` · `await seed_users()`, outside any try/except)
  and refuses to seed the seed file's publicly-known PIN (`backend/app/seed.py` ·
  `resolve_seed_pin`), so the process exits and `restart: unless-stopped` starts it again. Set a
  six-digit `SEED_PIN` in `.env` (not 000000/123456 – those are rejected too) and apply it:

  ```bash
  docker compose up -d          # add --profile tls if you run Caddy
  ```

  Nothing is lost: the migrations already ran, the refusal only stops the account seeding, and
  seeding runs again on the next boot because there is still nothing to seed over. The other
  lines worth looking for in the same output: a missing `SECRET_KEY`/`POSTGRES_PASSWORD`
  (compose names them in the error), and a refused pre-migration dump (§5).

  ⚠️ On the old **v0.6.0** image this same cause produces no restart loop at all – seeding is
  wrapped in a `try/except` there, so the stack comes up green with an empty roster and the
  only trace is a *"Seeding failed (continuing)"* line. If everything is healthy and nobody can
  log in, that is what you are looking at: [`SETUP.md` §1](SETUP.md) has both shapes and the fix.
- **`Bind for 0.0.0.0:8000 failed: port is already allocated`:** something else on the host owns
  the port. Set a free `APP_PORT` in `.env` and run `docker compose up -d` again – see §3.
- **Reference WMS does not load:** browser requests go directly to the configured WMS/WMTS.
  The provider must allow browser access from your deployment origin. If it does not, use a
  provider-supported public endpoint or proxy the layer through infrastructure you control.
- **Hydrants / Leitungskataster appear shifted:** check the uploaded coordinate reference system.
  KP Front expects runtime GeoJSON positions in WGS84 (`EPSG:4326`). Convert LV95/LV03 source data
  during import; do not relabel Swiss projected coordinates as latitude/longitude.
- **Everyone is logged out or PINs stop working after restart:** `SECRET_KEY` changed. Restore the
  previous stable value if possible. If it is gone for good, the way back is
  **`python -m app.reset_roster`** – it rewrites every user in the seed file with a PIN you pass,
  and deactivates everyone not in it, so run it with the *target* deployment's `SECRET_KEY` and
  `DATABASE_URL` (`CONFIGURATION.md` §9g has the exact invocation and the caveats). On a
  Docker-only host it needs no toolchain either:
  `docker compose exec app uv run python -m app.reset_roster`. Check `/admin` → Zugangsdaten in
  the same pass: the stored credentials are encrypted under a key derived from that same value,
  and they will be showing «unlesbar» (§6).
- **`ADMIN_SECRET` is lost – nobody can open `/admin`:** this one is **not** a
  never-rotate secret, and it is the exception worth knowing. It encrypts nothing and signs
  nothing; it is simply the value the admin login is compared against. Put a new one in `.env`
  (`openssl rand -hex 24`, ≥16 chars) and restart the app – `docker compose up -d`, or set the
  variable on the Railway service, which redeploys. Nothing else is affected: no PIN, no stored
  credential, no config version, no incident. Existing admin sessions are revoked immediately:
  each admin JWT carries a fingerprint of the current `ADMIN_SECRET`, and every protected request
  checks it (`backend/app/auth/security.py` · `admin_secret_fingerprint`). A browser that was
  already logged in is sent back to the admin login on its next request. (Compare `SECRET_KEY`
  above, where the same move is an outage.)
- **Migration failure on boot.** The app never finishes starting, so nothing it serves can help
  you – this is a terminal procedure by definition. In order:

  ```bash
  docker compose logs app | tail -n 60 > ~/kp-front-migration-failure.log   # 1. keep the reason
  docker compose stop app                                                   # 2. stop the loop

  # 3. The safety dump the failed boot already took for you, newest 5 kept, INSIDE the volume:
  docker compose run --rm --no-deps -T app ls -1t /data/storage/backups
  docker compose run --rm --no-deps -T app cat /data/storage/backups/pre-migrate-<stamp>.sql.gz \
      > pre-migrate-<stamp>.sql.gz          # copy it OUT before you touch anything

  # 4a. Roll back: pin the previous release and start again. The schema is still the old one,
  #     because the whole batch of migrations runs in one transaction (§5) – there is no
  #     half-migrated state to undo.
  sed -i 's|^KP_FRONT_TAG=.*|KP_FRONT_TAG=<previous>|' .env && docker compose up -d

  # 4b. …or, if something did get through, put the pre-migration database back:
  ./scripts/restore.sh --db-only pre-migrate-<stamp>.sql.gz
  ```

  `run --rm --no-deps` rather than `exec` in step 3 on purpose: the app container is not
  running, and that is the only reason you are here. **Do not delete the Postgres volume as a
  recovery shortcut** – it is the thing you are trying to save.

---

*See also: `CONFIGURATION.md` (what data to provide), `ARCHITECTURE.md` (how it fits together).*
