# DEPLOYMENT — self-hosting KP Front

**Status:** Two supported paths, both tested: **docker-compose on a VPS** (this doc) and
**Railway** (`railway.json`, one-click from the repo Dockerfile). Same image, same
auto-migrate-on-boot behaviour — pick by who runs the server. Decisions it encodes: Docker,
auto-migrate on boot (D8), local-volume storage (D10), one-instance-per-station (D3),
individual accounts (D5).

> **Railway + non-root (learned the hard way, 2026-07-02):** the image runs as uid 10001, but
> Railway mounts volumes **root-owned**, so the app can't write media and `/ready` correctly
> fails the deploy. Set **`RAILWAY_RUN_UID=0`** on the service (documented Railway override —
> the container then runs as root there, like any pre-non-root deploy). Compose self-hosters
> keep the non-root user; fresh named volumes inherit the app user's ownership. Note also that
> a failed Railway healthcheck did **not** keep the previous deployment serving — treat deploys
> that change the runtime user or healthcheck as maintenance windows.

```bash
railway variable set RAILWAY_RUN_UID=0 --service <app-service>
```

Verify `GET /ready` after the deployment; both `database` and `storage` must report `ok`.

> **Don't have a server / don't want to run one?** KP Front is open source and self-hostable,
> but we also offer **managed hosting** (Swiss datacenter) for a fee covering licensing +
> server costs. See `§7 Managed hosting`.

---

## 1. What you're deploying

One **deployment = one fire station** with its own database — no shared multi-tenancy. The
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
services — no credentials.

## 2. Requirements

- A host that can run Docker + Docker Compose (a small VPS — 1 vCPU / 1 GB RAM — is enough
  for one station; disk grows with uploaded plans + incident history, budget a few GB).
- For HTTPS: a domain pointed at the host. The bundled **`tls` profile runs Caddy** and gets
  a certificate automatically (Let's Encrypt / ZeroSSL) — no manual cert work. Or front it
  with your own reverse proxy / Traefik.
- Postgres: **bundled in the compose file** (the `db` service), or point `DATABASE_URL` at a
  managed Postgres and drop the `db` service.

## 3. Quick start (self-host)

Everything ships in the repo root: `docker-compose.yml`, `.env.example`, `deploy/Caddyfile`.

```bash
# 1. Get the code (or a tagged release)
git clone <repo> && cd kp-front

# 2. Configure secrets — 'just init-env' writes .env with all three generated for you:
just init-env               # POSTGRES_PASSWORD + SECRET_KEY + ADMIN_SECRET (note the ADMIN_SECRET it prints)
#    …or by hand: cp .env.example .env  and set  (see §4 and CONFIGURATION.md §6)
#    SECRET_KEY:   openssl rand -hex 32   (KEEP IT STABLE — it signs JWTs and peppers PINs)
#    ADMIN_SECRET: openssl rand -hex 24   (unlocks /admin; empty = admin disabled)

# 3a. Plain HTTP on APP_PORT (LAN / behind your own proxy). Build + migrate + seed on boot (D8):
docker compose up -d --build
#     On a trusted LAN with no TLS, set COOKIE_SECURE=false in .env so login cookies work.

# 3b. …or automatic HTTPS on a public domain (set DOMAIN in .env first):
docker compose --profile tls up -d --build

# 4. The first incident editor account is seeded from backend/app/seed_users.json on
#    first boot: user "fu" (Führungsunterstützung), stored role editor, PIN 000000.
#    Change the PIN after first login.
```

> **Production hardening is automatic** under compose: the app runs with `ENVIRONMENT=production`,
> which makes `SECRET_KEY` mandatory (no silent per-restart rotation), enables Secure cookies
> (unless you opt out with `COOKIE_SECURE=false`), and hands schema ownership to Alembic.

### Updating an image vs. building from source
The compose file **builds from the repo Dockerfile** by default, and CI builds + boots +
smoke-tests that exact image on every push, so `main` is always deployable. To pin a published
image instead, comment out `build:` in the `app` service and set
`image: ghcr.io/<org>/kp-front:vX.Y.Z`.

Pre-built images aren't published yet: GHCR storage is **billed for private packages**, and
this repo is private. Once it goes public, GHCR is free — at that point a tag-triggered build
can publish versioned images and self-host becomes `docker compose pull` (no Node/uv toolchain
on the VPS). Until then: `git pull` + rebuild.

Then open the app and **log in by picking your name + PIN**. For station setup, prefer the
config/CLI path in `CONFIGURATION.md` (`admin_config`, `admin_geodata`, `admin_objects`) so the
deployment is repeatable and reviewable. The admin UI is useful for visual inspection, basic edits,
and user/PIN maintenance. There is **no setup wizard** (D7). Incident roles are `editor`/`viewer`
(renamed from the legacy `commander` value 2026-06-30). Deployment administration is **separate
from the incident role**: the `/admin` UI and admin-write API/CLI are unlocked with the
**`ADMIN_SECRET`** env var (not the editor PIN). If `ADMIN_SECRET` is unset the admin surface is
disabled (fail-closed), so set it before you need to administer the station.

## 4. Configuration split

| What | Where | Who |
|------|-------|-----|
| Secrets / infra | `.env` (env vars) | operator, at deploy time |
| Station config + assets | private config/data repo → CLI → DB/reference store; admin UI for inspection/basic edits | technical deployment owner |
| Per-incident settings | in-app | any user, during an incident |

Full env reference: `.env.example` (compose) and `CONFIGURATION.md §6`. Minimum to boot via
compose: `POSTGRES_PASSWORD` + `SECRET_KEY` (≥32 chars); `DATABASE_URL` is assembled from the
Postgres vars automatically. For a managed Postgres, set `DATABASE_URL` directly instead. Set
`ADMIN_SECRET` (≥16 chars) too, or the `/admin` surface stays disabled.

## 5. Updating

```bash
git pull
docker compose up -d --build          # add --profile tls if you run Caddy
```
- The new image carries its DB migrations; **they run automatically on boot** (D8, via
  `start.sh` → `alembic upgrade head`). When a migration is actually pending, `start.sh`
  first writes a **pre-migration dump** to `<MEDIA_STORAGE_DIR>/backups/pre-migrate-*.sql.gz`
  (best-effort, newest 5 kept), so a bad migration is recoverable even without external backups.
- **Rollback:** check out the previous tag and rebuild. Migrations are kept backward-safe
  within a minor series, so the prior image runs against the migrated schema.
- **Postgres major upgrades** (e.g. 16→17) are *not* automatic — a 16 data volume won't be
  read by a 17 server. Stay on `postgres:16` for the life of the volume; to move majors, take a
  `pg_dump` (see §6), start a fresh volume on the new major, and restore.
- Watch the release notes for any breaking config changes.

## 6. Backups & data protection

- **Back up two things, together:** the Postgres database and the asset volume
  (`MEDIA_STORAGE_DIR`, the `storage` volume). A DB restored against an older/newer volume
  leaves media rows pointing at missing blobs — capture both at the same time.
- **`scripts/backup.sh` does both** (dump + volume tarball into one directory, with
  retention via `BACKUP_KEEP`, default 14). Schedule it from cron on the docker host:

```bash
# Daily at 03:30, keep two weeks:
30 3 * * * cd /opt/kp-front && ./scripts/backup.sh /var/backups/kp-front >> /var/log/kp-front-backup.log 2>&1
```

```bash
# Manual equivalents (run with the stack up):
docker compose exec -T db pg_dump -U kpfront kpfront | gzip > kpfront-$(date +%F).sql.gz
docker compose exec -T app tar czf - -C /data/storage . > storage-$(date +%F).tar.gz

# Restore into a fresh stack:
gunzip -c kpfront-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U kpfront kpfront
docker compose exec -T app sh -c 'tar xzf - -C /data/storage' < storage-YYYY-MM-DD.tar.gz
```
- **Do one restore drill** into a fresh stack before relying on the files — the incident
  record is only provably recoverable once you've actually restored it.
- On **Railway** the database is managed — use scheduled `pg_dump` against
  `DATABASE_PUBLIC_URL` from a machine you control, plus the automatic pre-migration dumps
  on the volume (§5).
- Single-instance isolation means **all your station's data is in your DB** — strong story for
  cantonal data-protection. If you process personal/operational data, follow your canton's DSG
  guidance. Minimum operational stance for an internal station release: keep exports and database
  backups access-controlled, document who can restore them, and define how long incident records,
  roster data, GPS traces, uploaded plans, photos, and audio notes are retained.

## 7. Managed hosting (paid)

If running a server isn't realistic for your corps, we host an instance for you:
- Dedicated instance + database (one per station — your data is isolated).
- Hosted in a **Swiss datacenter**.
- We handle updates, backups, TLS.
- Cost = licensing + server costs. Before public launch, publish a stable managed-hosting
  contact path in the README and on the demo instance.

## 8. Troubleshooting

- **Reference WMS does not load:** browser requests go directly to the configured WMS/WMTS.
  The provider must allow browser access from your deployment origin. If it does not, use a
  provider-supported public endpoint or proxy the layer through infrastructure you control.
- **Hydrants / Leitungskataster appear shifted:** check the uploaded coordinate reference system.
  KP Front expects runtime GeoJSON positions in WGS84 (`EPSG:4326`). Convert LV95/LV03 source data
  during import; do not relabel Swiss projected coordinates as latitude/longitude.
- **Everyone is logged out or PINs stop working after restart:** `SECRET_KEY` changed. Restore the
  previous stable value if possible; otherwise reset user PINs from an admin/seed path.
- **Migration failure on boot:** keep the failing container logs, take a database dump before
  retrying, then either roll back to the previous tag or fix the migration and restart. Do not
  delete the Postgres volume as a recovery shortcut.

---

*See also: `CONFIGURATION.md` (what data to provide), `ARCHITECTURE.md` (how it fits together).*
