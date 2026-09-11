# Agent runbook – standing up and maintaining a station headless

For an automation agent, or a human who wants the commands and nothing else. It assumes no
context beyond this file: every command is exact, every endpoint is named, and the four things
that genuinely cannot be done from a terminal are listed first.

The prose versions are [`SETUP.md`](SETUP.md) (a station, in order),
[`DEPLOYMENT.md`](DEPLOYMENT.md) (the host) and [`CONFIGURATION.md`](CONFIGURATION.md) (every
field). This file repeats none of their reasoning.

**Contents**

- [The four walls](#the-four-walls)
- [Day 0 – the sequence](#day-0--the-sequence)
- [Ongoing maintenance](#ongoing-maintenance)

---

## The four walls

Do these first or the sequence below stalls. Each needs a human with an account somewhere else.

| Wall | What must exist | Who | Blocks |
|------|-----------------|-----|--------|
| **DNS** | an `A` record for the station's domain pointing at the host, resolving before `setup.sh` runs | whoever owns the domain | HTTPS. Caddy's ACME challenge fails and the stack comes up without a certificate |
| **Azure** | an app registration in the brigade's Microsoft 365 tenant, `Sites.Selected` granted with admin consent (a PowerShell step), plus a client secret and its expiry date | a **tenant admin** | the SharePoint pull ([`sharepoint-connector.md`](sharepoint-connector.md)) |
| **Divera** | the unit accesskey, a personnel accesskey that can read Qualifikationen, and a webhook registered against this deployment (ALARM or PRO tier) | a Divera admin of the Einheit | alarm intake + the nightly Mannschaft sync ([`divera-connector.md`](divera-connector.md)) |
| **Railway** (that path only) | a volume mounted at **`/mnt/data`** and `RAILWAY_RUN_UID=0`, both set **before the first deploy** | whoever owns the Railway project | the boot itself – a fresh database cannot write its pre-migration dump and the service restart-loops ([`DEPLOYMENT.md` §3a](DEPLOYMENT.md#3a-railway-in-order)) |

Everything else below is scriptable.

---

## Day 0 – the sequence

### 1. Install

```bash
./scripts/setup.sh --yes --domain front.example.ch --backup-cron --backup-dir /var/backups/kp-front
```

With no terminal on stdin the installer never prompts, so `--domain` or `--lan` is **required**,
and without `--backup-cron` no schedule is installed at all. The full flag table is
[`SETUP.md` §1](SETUP.md#installing-without-a-terminal-in-front-of-it). The four secrets are generated into `.env`; two of them
(`ADMIN_SECRET`, `SEED_PIN`) are printed once – capture them from stdout.

Required in `.env`, whichever way it is written:

| Variable | Value |
|----------|-------|
| `POSTGRES_PASSWORD` | any strong value. Empty stops the stack by name |
| `SECRET_KEY` | `openssl rand -hex 32`. Signs JWTs, peppers PINs **and** encrypts the stored credentials – never rotate it casually |
| `ADMIN_SECRET` | `openssl rand -hex 24`. Empty = the whole `/admin` surface answers 403 |
| `SEED_PIN` | 6–12 digits, not a trivial one. Empty = the build refuses to boot |
| `TRUSTED_FORWARDED_HOPS` | `1` behind any reverse proxy (the `tls` profile, your own nginx, Railway), `0` on a plain LAN. `setup.sh` derives it; set it by hand if you wrote `.env` yourself. Left at `0` behind a proxy, every per-source rate limit keys on the proxy and collapses into one bucket |

### 2. Verify the boot – two URLs, not one

```bash
curl -fsS https://front.example.ch/ready            # database + storage both "ok"
curl -fsS https://front.example.ch/api/auth/roster  # must NOT be []
```

A green `/ready` with an empty roster means nobody can log in. Fix `SEED_PIN` and restart before
going further.

### 3. Open an admin session

```bash
curl -fsS -c /tmp/kp.jar -X POST https://front.example.ch/api/admin/login \
  -H 'Content-Type: application/json' -d '{"secret":"<ADMIN_SECRET>"}'
```

Sets an admin-session cookie; reuse the jar for every `/admin`-gated call below. Wrong secrets
are rate-limited per source and answer 401; 403 means `ADMIN_SECRET` is unset on the server.

### 4. Create the real accounts

```bash
curl -fsS -b /tmp/kp.jar -X POST https://front.example.ch/api/auth/users \
  -H 'Content-Type: application/json' \
  -d '{"username":"meier","display_name":"Meier Anna","role":"editor","pin":"482915"}'
```

- `role` is one of `editor` (FU, mutates the incident), `el` (Einsatzleiter – reads everything,
  writes only the record domains), `viewer` (read-only).
- `pin` is **6–12 digits**. A trivial PIN (`000000`, `123456`, …) is refused with **400**, as is
  a wrong length. A duplicate `username` is **409**.
- The response's `id` is a **UUID** – it is what `PATCH /api/auth/users/{id}` and
  `POST /api/auth/users/{id}/pin` take. Do not synthesise it.

Then retire the seeded install account: rename and re-PIN it, or `PATCH` it to
`{"is_active": false}`.

### 5. The config-as-code loop

The deployment config is one JSON document. From `backend/`:

```bash
uv run python -m app.admin_config schema      # the JSON Schema (no DB)
uv run python -m app.admin_config example     # a populated example to start from
uv run python -m app.admin_config validate station.json
uv run python -m app.admin_config diff station.json     # what would change
uv run python -m app.admin_config load station.json     # write, direct to the DB
```

Against a **running** deployment with no database access, `push` does the same over the API:

```bash
KP_BASE_URL=https://front.example.ch KP_ADMIN_SECRET=<secret> \
  uv run python -m app.admin_config push station.json
```

The committed schema is [`config.schema.json`](config.schema.json) – generate against it
offline, without a deployment.

Over HTTP only, the dry run is an endpoint:

```bash
curl -fsS -b /tmp/kp.jar -X POST https://front.example.ch/api/config/validate \
  -H 'Content-Type: application/json' --data @station.json
```

It writes nothing and answers with `errors` (`field.path: message`), `warnings` (keys the schema
dropped – not fatal), `emptiedSections`, `changedSections`, and the current `version`. Feed that
`version` to the write as `If-Match`:

```bash
curl -fsS -b /tmp/kp.jar -X PUT https://front.example.ch/api/config \
  -H 'Content-Type: application/json' -H 'If-Match: <version>' --data @station.json
```

Three refusals to handle, all of them deliberate:

| Status | Means | Do |
|--------|-------|----|
| **428** | no `If-Match` sent | read the `ETag` off the response and retry with it |
| **409** (stale) | somebody wrote since that version | re-read `GET /api/config`, re-apply your change on top, retry |
| **409** (`emptiedSections`) | the write would empty a populated section | verify that is intended, then repeat with **`?force=true`** |

`PUT /api/config` replaces the **whole** document. Always read → patch → write; never post a
partial one.

### 6. Station data, in this order

The order is mandatory – `admin_config load` replaces the whole document, and `identity.assets`
is part of it, so branding written before the config is overwritten by it.

```bash
cd backend
uv run python -m app.admin_config     load    ../station/config.json
uv run python -m app.admin_branding   load    logo       ../station/logo.png
uv run python -m app.admin_branding   load    reportLogo ../station/report-logo.png
uv run python -m app.admin_geodata    load    ../station/geodata.manifest.json
uv run python -m app.admin_objects    load    ../station/objects.manifest.json
uv run python -m app.admin_checklists load    ../station/checklists.manifest.json
```

Personnel comes last, and comes from Divera (`roster.autoSync`), a CSV import, or hand entry.

Every one of those CLIs shares the same verbs (`schema`, `example`, `validate`, `load`, `push`,
`show`) and the same `--base` / `--admin-secret` (`KP_BASE_URL` / `KP_ADMIN_SECRET`) flags.
**The runnable exemplar of the whole sequence is [`examples/demo-data/load.sh`](../examples/demo-data/load.sh)** – a
complete synthetic station, idempotent, safe against a fresh instance. Read it before writing
your own loader.

### 7. Credentials

```bash
curl -fsS -b /tmp/kp.jar -X PUT \
  https://front.example.ch/api/integrations/credentials/divera_access_key \
  -H 'Content-Type: application/json' -d '{"value":"<key>"}'
```

Stored encrypted, live without a restart, and **write-only** – `GET /api/integrations/credentials`
returns state (set / not set / server-set), never a value. A name whose variable is set in `.env`
is owned by the environment and answers **409**; leave those lines blank unless the deployer is
meant to own them. `DELETE` the same path clears one.

### 8. Ask whether it is done

```bash
curl -fsS -b /tmp/kp.jar https://front.example.ch/api/system
```

The `setup` block is the machine-readable checklist: `rows[]` of `{id, done}` over the nine
predicates `name, map, logo, users, personnel, fleet, geocoder, sharepoint, monitoring`, the ids
a human ticked off in `setup.acknowledged`, and `complete` folding the two. Poll it instead of
scraping `/admin`.

⚠️ `complete` is not "ready for the field". It knows nothing about backups, HTTPS, whether the
install PIN was changed, or where `ADMIN_SECRET` is written down. [`SETUP.md` §8](SETUP.md#8-before-you-rely-on-it-in-the-field)
is that list.

---

## Ongoing maintenance

### What runs itself

| Job | Cadence | Needs |
|-----|---------|-------|
| SharePoint pull – object plans, geodata, checklists, the Arbeitsmappe | scheduled | credentials **and** `sharepoint.sources` |
| Divera alarm intake | webhook, instantly; 120 s poll as fallback | webhook secret / unit accesskey |
| Mannschaft sync | nightly 04:17 Europe/Zurich, jittered | `roster.autoSync` ≠ `"off"` + a personnel key |
| Objektplan-Pull (S3) | `PLANS_PULL_INTERVAL_MINUTES` (60) | `PLANS_S3_*` |
| Backup | the crontab line `setup.sh --backup-cron` installed | disk, and a copy **off this machine** |

An Arbeitsmappe import that would refuse a row, empty a config section or deactivate anybody is
**not applied unattended** – the area reports «wartet auf Freigabe» and waits for a person at
`/admin` → **Daten › Arbeitsmappe**.

### Census and repair

Run from `backend/`. **Both report only by default; `--apply` is what writes.**

```bash
uv run python -m app.admin_objects show                    # what is stored, with plan counts
uv run python -m app.admin_objects merge-duplicates        # fold NFD/NFC twins + exact duplicates
uv run python -m app.admin_objects remove-empty            # objects with no plans and no references
uv run python -m app.admin_objects repair-sharepoint-keys  # fold pre-2026-09-11 whole-folder-key twins
uv run python -m app.admin_objects geocode-missing         # place plan-carrying objects without coordinates
```

- `merge-duplicates` is the fix for the twins a Mac-run import mints: macOS writes decomposed
  (NFD) filenames, so «Bürgerhaus» arrives a second time under a byte-different name. The
  survivor also moves onto the NFC id, so the next SharePoint sync finds it instead of minting a
  third.
- `repair-sharepoint-keys` folds the other twin class: objects a pre-2026-09-11 SharePoint sync
  keyed on the whole «Adresse - Name» folder string. Each bare copy merges into the older, richer
  object (newest sheet per slot wins), survivors are re-keyed onto the corrected convention, and
  what it splits out is geocoded.
- `geocode-missing` places every object that carries plans but no coordinates – by its address,
  or by its name where there is none. An object without a position is offered at **no** incident,
  so its plans are reachable by nobody; both commands end with that census.
- `remove-empty --name '<name>'` additionally deletes a named object, plans and all – for a
  category folder («Grosspläne») an import read as an Einsatzobjekt.
- **The verification is a second dry run.** Re-run without `--apply` after applying; a clean
  report is the confirmation. There is no undo.
- ⚠️ **Eyeball a geocoding dry run, do not just count it.** A range address («Hauptstrasse
  1-14») can resolve to a same-named street in the next town – an object sitting in the wrong
  place looks exactly like a correct one in a summary line. The report names the field it
  queried (`(its address)` / `(its name)`) for exactly this check.

### Where health is visible

```bash
curl -fsS -b /tmp/kp.jar https://front.example.ch/api/system          # connectors[] + setup
curl -fsS -b /tmp/kp.jar https://front.example.ch/api/sharepoint/status
```

`connectors[]` carries `sharepoint`, `divera_alarms`, `traccar` and `divera_personnel`, each with
`lastAttempt`, `lastSuccess`, `lastError` and `counts`. **The two timestamps are separate on
purpose:** a failed run never moves `lastSuccess`, so alert on the gap between them rather than
on `state` alone. `lastError` never carries a credential. The human view of the same data is
`/admin` → **System & Wartung**.

The dead-man's switch is `HEALTHCHECK_PING_URL` – a 60 s ping to a monitor you own. Without it,
nothing tells anybody the deployment is down; `restart: unless-stopped` only reacts to a
container that **exits**.

### What stays human

- **Azure client secret renewal.** Azure caps it at 24 months and says nothing when it lapses.
  `SHAREPOINT_SECRET_EXPIRES` is what the System card counts down – keep it accurate, and put the
  renewal in a calendar, not in a script.
- **The Divera portal.** Keys, webhooks and the rights of the personnel key's user.
- **Geodata for a new canton.** Sourcing hydrants, Leitungskataster and a WMS is a licensing and
  provenance question, not a fetch ([`geodata-architecture.md`](geodata-architecture.md)).
- **Deciding that a departed member is really departed** – `roster.autoSync: "safe"` counts them
  and leaves them active on purpose.
- **Restoring a backup.** `scripts/restore.sh` exists; a restore drill does not run itself.
