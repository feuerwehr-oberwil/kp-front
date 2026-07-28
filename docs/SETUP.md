# SETUP – from nothing to a station that can run an incident

This is the **ordered path**, written for someone setting KP Front up for their own fire station
for the first time. It links to the reference docs rather than repeating them:
[`DEPLOYMENT.md`](DEPLOYMENT.md) is the infrastructure reference,
[`CONFIGURATION.md`](CONFIGURATION.md) is the config schema, and
[`STATION-DATA.md`](STATION-DATA.md) covers your private data repository.

Budget roughly **half a day** for steps 1–3 and a **second session** for the station data. You
do not have to finish everything before the app is useful: after step 3 it runs incidents on
public swisstopo maps with a hand-entered roster.

---

## 0. Before you start

Have these in hand. Every one of them is something people go looking for halfway through.

| You need | Notes |
| --- | --- |
| A Docker host | A 1 vCPU / 1 GB VPS is enough for one station. Disk grows with plans, photos, and audio – budget a few GB. |
| A domain (recommended) | An `A`/`AAAA` record pointing at the host. The bundled `tls` profile then gets a certificate automatically. Without one you run plain HTTP on a trusted LAN – see the gotcha in §7. |
| A decision: who administers this | Deployment administration is a **separate secret** from any user login. Decide who holds it. |
| Optional: a Divera 24/7 access key | Only if you want alarms and roster sync. Everything works without it. |
| Optional: your station's geodata | Hydrant layers, Leitungskataster, object plans. These are **never** bundled with KP Front – they are yours, and they come later in step 4. |

**One decision worth making now:** KP Front is single-tenant. One deployment serves one station.
If you are setting this up for several stations, that is several deployments, not one instance
with a switch.

---

## 1. Get it running

```bash
git clone https://github.com/feuerwehr-oberwil/kp-front.git
cd kp-front
git checkout "$(git tag -l 'v*' --sort=-v:refname | head -n1)"   # newest release, not main – see §6
just init-env                # generates POSTGRES_PASSWORD, SECRET_KEY and ADMIN_SECRET into .env
```

`just init-env` **prints the generated `ADMIN_SECRET`. Save it now** – it is the only thing that
unlocks `/admin` later, and it is not recoverable from the running app.

Then start the stack:

```bash
# With a domain (set DOMAIN in .env first) – automatic HTTPS via Caddy:
docker compose --profile tls up -d

# …or plain HTTP on a trusted LAN – also set COOKIE_SECURE=false in .env, see §7:
docker compose up -d
```

Migrations run on boot; there is no separate migrate step and no setup wizard.

**Check it came up properly** before going further:

```bash
curl -s https://<your-domain>/ready
```

Both `database` and `storage` must report `ok`. A `storage` failure here is almost always a
volume-permission problem, and it is much easier to fix now than after you have data.

## 2. Take over the seeded account

First boot seeds one editor from `backend/app/seed_users.json`: user **`fu`**
(Führungsunterstützung), PIN **`000000`**.

1. Log in with it.
2. **Change the PIN immediately.** It is a documented default in a public repository.
3. Open `/admin` (unlock with the `ADMIN_SECRET` from step 1) and create the accounts your crew
   will actually use.

Incident roles are only two: **`editor`** may change incident state, **`viewer`** is read-only.
Deployment administration is not a role – it lives behind `ADMIN_SECRET` and is fail-closed, so
an unset secret means the admin surface is simply off.

At this point you have a working incident app on public swisstopo maps. Everything below makes
it *your station's* app.

## 3. Make it your station

Station configuration is **managed as code** so the deployment stays repeatable and reviewable.
The admin UI is for inspection and small edits, not the primary path.

```bash
cd backend
uv run python -m app.admin_config example > private/mystation.config.json
# edit it: identity, branding, accent colour, map centre, fleet, doctrine, locale
uv run python -m app.admin_config validate private/mystation.config.json
uv run python -m app.admin_config diff     private/mystation.config.json   # ← read this
uv run python -m app.admin_config load     private/mystation.config.json
```

**Always run `diff` before `load`.** `load` replaces what is there. If anyone has edited config
through the admin UI since your file was written, a blind `load` silently reverts their changes –
this has bitten us on our own production deployment.

Set the **locale** here too (`identity.locale`). It is a per-deployment setting resolved once at
boot, not a per-device preference: one brigade, one language. German, French, Italian and English
ship; German is the canonical catalogue and anything untranslated falls back to it.

Then the roster – either Divera sync (§4) or manual entry / CSV import. See
[`CONFIGURATION.md` §4](CONFIGURATION.md).

## 4. Load your station data (the second session)

Reference geodata, object plans, and checklists are **yours, not ours** – nothing is bundled, and
there is no fallback to another station's data. Each has a CLI keyed off `KP_ADMIN_SECRET`:

| Data | CLI | Format gotcha |
| --- | --- | --- |
| Hydrants, Leitungskataster, cantonal WMS | `admin_geodata` | GeoJSON must be **WGS84 `[lng, lat]`**. LV95 is rejected – convert at import, never relabel. |
| Object plans (Einsatzpläne) | `admin_objects` | PDF plus a manifest. Missing plans fall back to OSM outlines and a Tafel, never to bundled files. |
| FU/EL checklist templates | `admin_checklists` | Falls back to one neutral bundled example if you load nothing. |

[`STATION-DATA.md`](STATION-DATA.md) walks through building the private repository these come
from, starting from the synthetic Musterdorf example. Its **Definition of ready** section is the
checklist for this step.

## 5. Connect what you have (all optional)

Every integration is fail-closed: no credential means the feature is off, not broken. Add them to
`.env` and restart. Full list and formats in [`.env.example`](../.env.example).

- **Divera 24/7** – `DIVERA_ACCESS_KEY` for alarms and roster. A second key
  (`DIVERA_PERSONNEL_ACCESS_KEY`) with permission to read Qualifikationen additionally derives
  each member's Dienstgrad. `DIVERA_WEBHOOK_SECRET` enables push alarms; without it, polling still
  works.
- **Any other alerting system** – `ALARM_WEBHOOK_SECRET` opens `POST /api/alarms`. No vendor
  account, no code. See [`ALARM-INTEGRATIONS.md`](ALARM-INTEGRATIONS.md).
- **Traccar** – live vehicle positions on the Lage map.
- **Web Push** – `cd backend && uv run python -m app.gen_vapid`, paste both keys. Without them,
  Atemschutz and reminder alarms only fire while the app is in the foreground. **If your station
  relies on the Atemschutz clock, do this one.**
- **Speech-to-text** – any OpenAI-compatible endpoint (Groq's free tier, OpenAI, or a self-hosted
  faster-whisper). Audio leaves your instance only if you set this.
- **Station printer** – `PRINT_AGENT_SECRET` plus the polling agent, which now lives in
  kp-rueck and serves both systems: see [`tools/PRINT-AGENT.md`](../tools/PRINT-AGENT.md).

## 6. Backups, before you rely on any of it

```bash
# Daily at 03:30, keep two weeks:
30 3 * * * cd /opt/kp-front && ./scripts/backup.sh /var/backups/kp-front >> /var/log/kp-front-backup.log 2>&1
```

The database and the asset volume must be captured **together** – a database restored against a
mismatched volume leaves media rows pointing at blobs that aren't there.

**Do one restore into a fresh stack before you go live.** An incident record is only provably
recoverable once you have actually recovered it. Details in [`DEPLOYMENT.md` §6](DEPLOYMENT.md).

Pin your version while you are here. A full version (`KP_FRONT_TAG=X.Y.Z`) follows nothing, the
series (`X.Y`) follows patch fixes, `latest` follows everything. A station that updates
deliberately wants one of the first two; which versions exist is the
[releases page](https://github.com/feuerwehr-oberwil/kp-front/releases). What a version bump
costs you is the table at the top of [`CHANGELOG.md`](../CHANGELOG.md).

---

## 7. The things that bite

Ordered by how often they catch people.

1. **`SECRET_KEY` must never change.** It signs sessions *and* peppers PINs. Rotate it and
   everyone is logged out and every PIN stops working. Back it up with your secrets, not with
   your code.
2. **Plain HTTP on a LAN needs `COOKIE_SECURE=false`.** Otherwise the browser silently drops the
   login cookie and sign-in fails with no visible error.
3. **GeoJSON must be WGS84.** Swiss source data is usually LV95. Relabelling projected
   coordinates as latitude/longitude puts your hydrants in the North Sea.
4. **`admin_config load` replaces.** Run `diff` first. Every time.
5. **Postgres majors don't upgrade themselves.** A 16 volume will not be read by a 17 server.
   Stay on `postgres:16` for the life of the volume; to move, dump and restore into a fresh one.
6. **On Railway, set `RAILWAY_RUN_UID=0`.** Railway mounts volumes root-owned, the image runs as
   uid 10001, and the mismatch fails `/ready` on storage.

## 8. Before you rely on it in the field

Not a formality – this is the list that separates "it's installed" from "we can run an incident
on it".

- [ ] `GET /ready` reports `database` and `storage` both `ok`.
- [ ] The seeded `000000` PIN is gone and real accounts exist.
- [ ] `ADMIN_SECRET` is stored somewhere you will find it in six months.
- [ ] Run a **Probe-Einsatz** end to end: open an incident, draw on the Lage, place symbols, run
      an Atemschutz Trupp to alarm, write Verlauf entries, print the Rapport.
- [ ] Do that Probe-Einsatz **with the tablet in flight mode** for part of it, and confirm the
      edits sync when you come back online. This is the feature you will need at 3am and the one
      least likely to be tested by accident.
- [ ] Confirm offline readiness reports what you expect on the tablet you will actually use.
- [ ] One restore drill from backup into a fresh stack.
- [ ] If Atemschutz matters to you: VAPID keys set, and an alarm actually arrived on a locked
      tablet.

## 9. Where to go next

- [`CONFIGURATION.md`](CONFIGURATION.md) – every config field and asset format.
- [`STATION-DATA.md`](STATION-DATA.md) – building your private data repository.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) – updating, rollback, backups, troubleshooting.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) – how the pieces fit together, and why.

Stuck, or something here was wrong for your station? Open a
[discussion](https://github.com/feuerwehr-oberwil/kp-front/discussions) – setup friction is a bug
report we want.
