# Alarm integrations: inbound intake & outbound webhooks

*Status: shipped 2026-07-08. How alarms get **into** KP Front from any alerting system, and how
incident-created events get **out** to whatever a station wires up (slip printers, chat bots,
pagers). KP Front core stays printer- and vendor-agnostic; everything here is config.*

## The pieces

```
alerting system ──POST /api/alarms──► KP Front ──alarms.webhooks──► your adapter (printer/bot/…)
      (or Divera webhook/poll)           │
      │                                  └── auto-opens the incident; the Erfassungs-Poster
      │                                      (/e/<token>) reaches it for captureWindowHours
      └── puts /l/<token> in the alert ──► responder's phone: that one incident, read-only
```

## 1. Inbound: generic alarm intake – `POST /api/alarms`

For stations **not** on Divera (which has its own integration), or for scripts/dispatch
systems. Every accepted alarm **auto-opens an incident** – as does every other intake path
since 2026-08-02. Auto-open is no longer configurable and no longer filtered: an alarm nobody
attends is kept out of the statistics afterwards (`editor_opened_at`,
[`STATS-EXPORT.md`](STATS-EXPORT.md)), not kept out of the app beforehand.

- **Auth:** the alarm webhook secret, sent as `?secret=` or `X-Webhook-Secret`. Fail-closed:
  unset → 403 for everyone. Setting it is the opt-in.
  - **Where a station sets and rotates it: `/admin` → Zugangsdaten.** `./scripts/setup.sh`
    mints it on a fresh install into the **encrypted credential store**, not into `.env`, so a
    normal deployment already has one and nobody has to generate anything. Rotating it there
    takes effect **without a restart** – and invalidates every sender still using the old value,
    so change the alerting system's copy in the same sitting. `./scripts/setup.sh --credentials`
    re-runs just that step against an already-installed deployment and never clobbers a value
    that has been rotated.
  - It is **write-only**: the page can set and rotate it, never show it back. If nobody wrote
    down what the installer minted, rotate to a value you choose rather than trying to read it.
  - `ALARM_WEBHOOK_SECRET` in `.env` still works and **outranks** the stored value, which then
    reports itself as server-set and refuses to save (409). Use it when you want this
    deployment's environment, and nobody with an admin session, to own the secret.
    [`CONFIGURATION.md` §6](CONFIGURATION.md#6-environment-variables-secrets--infra--operator-not-admin).
- **Idempotent:** one incident per `(source, source_id)` – a retried delivery returns the
  existing incident (`200`, `"created": false`) instead of duplicating it.
- `type`/`priority` fall back to the same keyword inference the Divera path uses – the alarm
  keyword vocabulary is not vendor-specific, and a station whose dispatch words differ replaces
  it from its deployment config (`alarmKeywords`, [`CONFIGURATION.md §1a`](CONFIGURATION.md)).
- **Send `started_at`** – the moment the alarm went out, not the moment you POST. It becomes
  the incident's Alarmierungszeit, and it is what the Rapport prints and the statistics
  export joins on. Omit it and the incident falls back to the time the request arrived, which
  is recorded as having *unknown* provenance (`started_at_source: null` in the export) so no
  downstream consumer mistakes your delivery time for an alarm time. The Divera integration
  does the same thing with the alarm's own `ts_create`.
- `source` is a short slug naming the upstream (`leitstelle`, `pager`, …). Reserved, and
  rejected with `422`: `divera`, `intake`, `manual`, `migrated`, `operator`, `training` — the
  union with KP Rück's list, so one sender can address both systems (see below).

```bash
curl -X POST "https://front.example.org/api/alarms?secret=$ALARM_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "leitstelle",
    "source_id": "E-2026-0815",
    "title": "BMA Alarm Industriestrasse",
    "address": "Industriestrasse 5, 4104 Oberwil",
    "lat": 47.514, "lng": 7.558,
    "priority": "HIGH",
    "started_at": "2026-07-08T14:32:00+00:00"
  }'
# → 201 {"incident_id": "…", "created": true}
```

### Contract stability

What a sender can rely on:

- **Additive only.** New optional fields may appear; existing ones will not be removed,
  renamed, or made stricter within a major version. Unknown fields in your payload are
  **ignored**, so sending extra keys is safe and forward-compatible.
- **A breaking change to this endpoint is a MAJOR release**, with the migration written up in
  [`CHANGELOG.md`](../CHANGELOG.md). It will not happen in a patch.
- **Idempotency is part of the contract**, not an implementation detail: retrying the same
  `(source, source_id)` is always safe.

### Talking to both KP Front and KP Rück

KP Rück has an endpoint with the same name and the same idea, but the two are **independent
implementations, not one shared specification** – they were built for different jobs and their
payloads have drifted. If you are writing one sender for both, stay inside the portable subset:

| Field | Portable | Notes |
| --- | --- | --- |
| `title` | ✅ required by both | KP Rück caps it at 255 characters |
| `source` | ✅ | Keep it ≤16 chars and matching `^[a-z0-9][a-z0-9_-]*$` – KP Front is the stricter of the two |
| `source_id` | ✅ **always send it** | **Required** by KP Front, optional in KP Rück |
| `text`, `address` | ✅ | KP Rück caps them at 5000 / 500 characters |
| `lat` + `lng` | ✅ | WGS84, both or neither |
| `type`, `priority`, `started_at` | KP Front only | Ignored by KP Rück |
| `number` | KP Rück only | Ignored by KP Front |

Avoid the union of both reserved `source` slugs: `divera`, `manual`, `migrated`, `operator`,
`intake`, `training`.

**Do not share a response parser.** KP Front answers `{"incident_id": …, "created": …}`;
KP Rück answers `{"status": …, "created": …, "emergency_id": …, "auto_attached_incident_id": …}`.
Only `created` means the same thing in both.

### Milestone enrichment – `POST /api/alarms/milestones`

The alarm pipeline can push per-group alarm times and per-vehicle Ausrück/Vor-Ort/Zurück
times as they happen (e.g. derived from GPS geofence events). Same secret as the intake;
targets an existing incident by `divera_id` **or** the intake's `(source, source_id)` pair –
**404 while none matches** (send with retry/backoff; dispatch precedes take/auto-open by
minutes at most). Idempotent per-key upsert into the incident's Rapport fields; entries an
operator edited (`manual`) are never overwritten; unknown ids are kept verbatim. Each NEW
value also appends a journal row («TLF ausgerückt 03:16»). Group/vehicle ids should match
`alarms.groups[].id` / `fleet.vehicles[].id` in the deployment config.

```bash
curl -X POST "$BASE/api/alarms/milestones" \
  -H "X-Webhook-Secret: $ALARM_WEBHOOK_SECRET" -H "Content-Type: application/json" \
  -d '{
    "divera_id": 4711,
    "origin":   "alarmzentrale",
    "groups":   [{ "id": "g2",  "alarmedAt":  "2026-07-13T01:12:00Z" }],
    "vehicles": [{ "id": "tlf", "ausgerueckt": "2026-07-13T01:16:40Z" }]
  }'
# → 200 {"incident_id": "…", "applied": 2}   (replay → "applied": 0)
```

**`origin` (optional)** – where the alarm came *in* from, as the alerting system knew it: a
short lowercase slug such as `alarmzentrale`, **never a phone number**. It answers a question
none of the other fields do — a dispatch and an alarm somebody raised by hand are usually
both allowlisted and otherwise identical here — and it is what a consumer needs to decide
whether an Einsatz may reach a public surface.

It is recorded **write-once** on the incident (`alarm_origin`, exposed in the stats export):
the first milestone carrying it wins and no later one rewrites it, for the same reason
`confirmed_at` is a latch. It does **not** count towards `applied` and appends no journal row
— it is a property of the alarm, not something that happened during the Einsatz.

Omitting it is normal and means *unknown*, not *no*. Senders that cannot know the origin —
notably a fallback relay running while the main service is unreachable — simply leave it out.

### FireHub (Tercero) – `POST /api/firehub/webhook`

FireHub has **no** public REST API for our use case, but it fires **station-configured
webhooks** on the triggers «Einsatzstart» and «Einsatzende». Point both at
`POST /api/firehub/webhook`; there is nothing to configure server-side, and nothing to key
`configured` off, so the capability registry lists FireHub as a discoverable-but-unconfigured
choice under the `alarms` domain.

**Auth: put `?secret=…` in the target URL.** The webhook target URL is freely choosable, but
FireHub's JSON **schema and headers are fixed** (a payload-wide format, not per-webhook
configurable), so a custom `X-Webhook-Secret` header is not an option. The station appends
`?secret=<alarm_webhook_secret>` to the URL instead – the **same `alarm_webhook_secret`** as the
generic intake above, fail-closed when unset.

Payload sent (as of 2026-08):

```json
{
  "operation": {
    "opsID": 1,          // STABLE, never changes → idempotency + start↔end link key (source_ref)
    "opsNumber": 1,      // human reference ("E-1"), VOLATILE (merges/backfills) → display-only, ignored
    "category": "firealarm",
    "title": "Oberwil: Feueralarm",
    "street": "Teststrasse 112",
    "city": "Oberwil",   // added by Tercero shortly after this adapter – omitted by older payloads
    "created": "2026-08-24T18:25:07.000Z"
  },
  "status": "OK",
  "trigger": { "type": "operation", "action": "start", "techName": "operation_start" }
}
```

- **`action: "start"`** → **auto-opens an incident**, exactly like the generic `POST /api/alarms`
  path (title ← `title`, address ← `street` + `city`, Alarmierungszeit ← `created`; `category`, an
  English slug, is deliberately not mapped – the German title already carries the keyword the
  type inference reads). Idempotent on `(source="firehub", source_id=opsID)` – and because
  **`opsID` never changes** while **`opsNumber` can** (operations merged, past ones backfilled),
  the dedup/link key is `opsID`, never the display number. A redelivered start returns the
  existing incident. It does **not** use the Divera pool – that pool is keyed by `divera_id` and
  is Divera's; FireHub rides KP Front's provider-neutral intake, source-tagged.
- **`action: "end"`** → **stamps the Einsatzende** on the matching incident's Rapport
  (`Incident.closed_at`, which the sheet reads as `reportMeta.endedAt ?? closed_at`, so an
  operator-entered value still wins). FireHub sends no end timestamp, so the receipt time is
  used, and `closed_at` is write-once – a redelivered end, or one arriving after the operator
  already closed the Einsatz, changes nothing. It is **not** archived/closed: retiring the
  Einsatz and releasing its crew stays the operator's decision (`is_open` ignores `closed_at`).
  An `end` for an operation we never opened is a no-op. A Wehr that does not want the stamp
  simply does not wire the Einsatzende webhook.
  - **This is the one place KP Front and KP Rück behave differently on purpose.** KP Rück does
    not own the Einsatzrapport, so its `end` only records an audit-log note; KP Front owns the
    Rapport, so its `end` stamps the Einsatzende there. Start behaviour, the field mapping, the
    source slug and the auth are identical between the two.
- **Limits today:** FireHub sends **no coordinates** – the map pin is geocoded from the
  composed `street` + `city` address (the `lat`/`lng` field aliases are already wired for the
  day Tercero adds them). `city` itself is a payload-wide addition still rolling out, so the
  address degrades to street-only for older payloads. Personnel/response data exists in FireHub
  but is not sent by webhook yet.

## 2. Outbound: incident-created webhooks – `alarms.webhooks`

Deployment config (`docs/CONFIGURATION.md` §1):

```jsonc
"alarms": {
  "webhooks": ["https://printer-adapter.local/kp-front"]
}
```

Every incident creation (manual wizard, Divera take, Divera auto-open, generic intake)
POSTs this JSON to each URL – **fail-open**: retried (0s/2s/8s), logged, never blocking or
delaying intake:

```jsonc
{
  "event": "incident.created",
  "incident": {
    "id": "…", "title": "BMA Alarm Industriestrasse",
    "type": "BMA / unechte Alarme", "priority": "HIGH",
    "address": "Industriestrasse 5, 4104 Oberwil",
    "lat": 47.514, "lng": 7.558,
    "source": "leitstelle", "source_ref": "X-1",
    "started_at": "2026-07-08T14:32:00+00:00",
    "auto_opened": true
  },
  "capture_url": "https://front.example.org/e/<token>"   // null unless PUBLIC_URL is set
                                                          // AND the Erfassungs-Poster is active
}
```

Set `PUBLIC_URL` (env) to the deployment's public origin so `capture_url` can be composed.

`source_ref` is the **upstream's own id** for the alarm (the `source_id` a generic intake
sent, or the Divera alarm id) – `null` for manually created incidents. It is what lets a
sender correlate this event with an alarm it is still holding something for: the milestone
pipeline (§1, `POST /api/alarms/milestones`) answers 404 until the incident exists, so it
subscribes to this webhook and delivers its queued times the moment one opens, instead of
waiting out its retry cadence.

### Example adapter: kp-rueck thermal QR slip

If the station runs [kp-rueck](https://github.com/feuerwehr-oberwil/kp-rueck) with its print
agent, a per-alarm slip (times + capture QR) is a few lines – kp-rueck's existing
`POST /api/print/qr-code` does the printing:

```python
# tiny webhook receiver → kp-rueck slip. Run anywhere both hosts are reachable.
from fastapi import FastAPI, Request
import httpx

KP_RUECK = "https://kp-rueck.example.org"
app = FastAPI()

@app.post("/kp-front")
async def incident_created(req: Request):
    p = await req.json()
    inc, url = p["incident"], p.get("capture_url")
    label = f"{inc['title']}\n{inc.get('address') or ''}\nAlarm: {inc['started_at'][11:16]}"
    # kp-rueck's endpoint has a TRAILING SLASH, requires `title`, calls the payload field
    # `qr_content`, and is editor-gated — so the receiver needs a logged-in kp-rueck session
    # cookie (or a master token), not just network reachability.
    async with httpx.AsyncClient(cookies=KP_RUECK_SESSION) as c:
        await c.post(f"{KP_RUECK}/api/print/qr-code/",
                     json={"qr_content": url or inc["id"], "title": inc["title"],
                           "subtitle": label})
    return {"ok": True}
```

## 3. The Erfassungs-Poster (station capture)

Independent of any printing: the admin UI (Personen › Erfassung) prints a **static A4
poster** for the Magazin wall. Scanning it opens `/e/<token>` – attendance, material,
Einsatzende and notes for incidents of the last `alarms.captureWindowHours` (default 12),
no login. Trust model: access to the station = permission, like the clipboard it replaces.
Rotate the token in the admin UI to invalidate every printed poster at once; delete it to
turn the surface off (fail-closed).

## 4. The Einsatz-Link (read-only link into one incident)

The poster's sibling, for the people who are not at the Magazin: the alerting system puts a
**URL into the alert it sends out**. A responder taps it on a personal phone and sees *that one
incident* the way a `viewer` account sees it – Lage map, Pläne, Hydranten, Checklisten, Verlauf.
No login, and nothing that writes, prints, costs money or leaves the building. Any alerting
system can do this; Divera is only the common case.

```
alert text …  https://front.example.org/l/<token>
                       │  responder taps it
                       ▼
       POST /api/incident-link/session  { token }   → sets the link_session cookie
                       │
                       ▼
       the app opens on that incident, read-only
```

`/l/<token>` mirrors the poster's `/e/<token>`. The token is minted **by the alerting system,
offline** – KP Front is never called to issue it. That is a requirement, not a convenience: the
alerting system sits on the life-critical path and must not acquire a runtime dependency on this
app being reachable.

### Minting the token

A JWT signed **HS256 with the station's `incident_link_key`**, naming the incident the way the
sender already knows it:

The key generated by current releases contains 256 bits of entropy, matching RFC 7518 §3.2.
Keys minted by older releases remain valid so an upgrade does not silently break the alerting
system; rotate and copy the new value during the next planned integration maintenance window.

| Claim | Value |
| --- | --- |
| `type` | `"incident-link"` – nothing else is accepted, so a credential minted for another purpose can never become a link session |
| `src` | the same `source` slug the sender uses for `POST /api/alarms` (`leitstelle`, `divera`, …) |
| `ref` | the sender's own alarm id – the `source_id` from the intake, or the Divera alarm id |
| `exp` | standard JWT expiry; checked on exchange |

`src` + `ref` are exactly the pair the intake deduplicates on (`Incident.source` /
`source_ref`), and that is what keeps this provider-neutral: **an alerting system never has to
learn KP Front's incident UUIDs** – it links to the alarm it already sent.

A link whose alarm is still sitting in an intake pool **opens it** (2026-08-02). Before that,
the responder holding the link waited on a colleague opening the alarm on a tablet and saw
«Einsatz nicht (mehr) verfügbar» until they did – the link was only as fast as the slowest
person at the Magazin. Opening grants nothing extra: the session that follows is the same
read-only viewer, and the incident stays *unconfirmed* until an editor works it, so a link
tapped for a turnout that never happened never reaches the statistics. Still send the intake
(§1) before or with the alert: an alarm neither the incident table nor any pool knows answers
«nicht (mehr) verfügbar», and works on the next tap.

```python
# in the alerting system, at alarm time — no call to KP Front
import jwt, time
token = jwt.encode(
    {"type": "incident-link", "src": "leitstelle", "ref": "E-2026-0815",
     "exp": int(time.time()) + 12 * 3600},
    INCIDENT_LINK_KEY, algorithm="HS256",
)
alert_text += f"\nLage: https://front.example.org/l/{token}"
```

### Two keys, deliberately

| Key | Held by | Signs | Managed |
| --- | --- | --- | --- |
| `incident_link_key` | the station **and** its alerting system | the inbound link token | DB row, admin UI (read / rotate / delete) |
| `SECRET_KEY` | KP Front alone – it never leaves the app | the resulting `link_session` cookie | env var, deploy time |

The station key can do exactly one thing: ask for a link session. It is deliberately **not**
`SECRET_KEY`, and that separation is the point – `SECRET_KEY` peppers every PIN and mints admin
sessions, so an alerting system holding it could issue itself deployment-admin access without
ever knowing `ADMIN_SECRET`.

KP Front generates the key; the admin copies it into the alerting system (admin UI: Daten ›
Einsatz-Link – enable/rotate/delete). Three admin endpoints
(`ADMIN_SECRET` session, not the editor role – handing this key out grants read sessions on every
incident the station will ever have): `GET /api/incident-link/secret` shows the current one,
`POST /api/incident-link/secret/rotate` mints a fresh one, `DELETE /api/incident-link/secret`
turns the surface off.

**Fail-closed:** no `incident_link_key` configured → `POST /api/incident-link/session` answers
`403` and there is no link surface at all. Minting the key is the opt-in – an upgrade adds the
column as `NULL` and therefore changes nothing until a station acts. Rotating or deleting it
invalidates every link already sent out, so a rotation and reconfiguring the alerting system are
one operation, not two.

### What the link reaches – and what it deliberately cannot do

The reachable surface is an **allowlist**, not a blocklist. There are roughly 40 routes a
`viewer` may call today; a blocklist would silently grant every route added after this control
was written, and surviving future edits is the one thing it has to do.

On the list – the incident itself (Stammdaten, workspace/Lage + Plan, Personen, Notizen,
Verlauf, Ereignisse, Snapshot, Status), the station reference data without which the map is
useless (Objekte und Objektpläne, Referenz-Layer wie Hydranten, Personal, Medien), the
deployment config and branding, and two pieces of **live display data**: vehicle positions and
trails, and weather. Those two are the only outbound calls allowed, and they are in on purpose –
they carry no personal data, and leaving them out would make the link visibly poorer than the
`viewer` account it is meant to mirror.

Off the list, each for a stated reason:

| Refused | Why |
| --- | --- |
| Einsatzrapport / Zeitplan **PDF** | generates a document carrying attendance and names |
| Rapport / Zeitplan **print**, print-job cancel | makes the station's printer print, or kills someone else's job, from a forwarded URL |
| Push subscriptions | writes rows tied to a user |
| Geocoding, Overpass | billable third-party calls, and an open proxy |
| `media/*/peaks`, `media/*/transcription` | `GET`s that are not reads – they write a file or mutate a job row |
| Diagnostics report | enqueues outbound telemetry |
| Everything that writes | a link is a read surface, full stop |

**Scope is enforced twice.** Being allowlisted is not enough: a route that names an incident
must name *the* incident the token was minted for, or a link to one Einsatz reads every other
one. There is no incident list and no roster login behind a link.

**Every refusal looks the same.** Inside a link session, every route that is not allowed is one
`403` with one message – a link holder must not be able to tell "that route exists but you may
not have it" from "no such route", because the difference is a map of the API drawn by probing.
The exchange answers the same way: any unusable token is `401` (bad signature, wrong type,
missing claims and expiry are all just "this link doesn't work"), and unknown, closed and
archived incidents are one `404`, so a link cannot be used to find out which Einsätze the
station has.

A **real login always wins**: if the person tapping the link is also a logged-in user, the
access cookie takes precedence and a stale link cookie can never narrow what they may do.
`GET /api/auth/me` reports `link_scoped` and `link_incident_id` for a link session, so the app
can hide the controls that would 403 instead of showing dead buttons.

**Lifetime: until the Einsatz is closed, and at most 12 h.** The incident is re-checked on
*every* request a link session makes, not only at exchange – so closing or archiving the Einsatz
revokes every link to it immediately, on the phones that already have it open, with no admin
action needed. `incident_link_session_ttl` (12 h by default) is only the backstop for the
incident nobody ever closes. That is also why the key rotation above is for *revoking early*,
not for routine hygiene.

The one exemption is the SPA fallback route: the app shell keeps being served after the link
dies, so a responder gets KP Front's own "nicht mehr verfügbar" screen instead of a bare JSON
`403` where the HTML should be.

Trust model: **the URL is the credential** – possession of the alert, the same authority as
knowing the Einsatz happened at all. It travels to personal phones and can be forwarded, so read
it as "everyone who receives the alert may see this Einsatz until it is closed", including the
station roster, who is on the Einsatz and what the Verlauf says. Weigh that where a station's
data-protection notes live ([`PRIVACY.md`](../PRIVACY.md)); if it does not hold for a
deployment, leave `incident_link_key` unset and the surface does not exist.

## Security notes

- All four secrets are independent and fail-closed: the alarm webhook secret (inbound), the
  poster token (capture), `incident_link_key` (Einsatz-Link), `ADMIN_SECRET` (administration).
  Three of the four are managed in the browser and stored in the database – the alarm webhook
  secret at `/admin` → **Zugangsdaten** (encrypted; `ALARM_WEBHOOK_SECRET` in `.env` outranks and
  locks it), the poster token under Personen › Erfassung, `incident_link_key` under Daten ›
  Einsatz-Link. **Only `ADMIN_SECRET` is env-only**, and deliberately so: it gates writing the
  very document it would otherwise live in.
- Outbound webhook URLs are admin-set config, pinned to `http(s)`; the payload contains the
  capture URL (a capability) – point webhooks only at receivers you trust.
- The capture surface reaches unarchived incidents without a completed Rapport at **any**
  age (the open backlog), plus anything inside `alarms.captureWindowHours` regardless of
  report state — and only attendance/material/journal/Einsatzende/Beilagen. The workspace
  endpoints are key-scoped to `attendance`, `mittel`, `reportMeta` and `attachments`
  (`CAPTURE_WORKSPACE_KEYS` in `backend/app/api/capture.py`): the tactical map is neither
  readable nor writable with a poster token, and a capture save merges over the server's copy
  so it cannot clobber it. `attachments` (Rapport-Beilagen, added 2026-08-06) comes with one
  write route for the bytes — `POST /api/capture/incidents/{id}/media`, **photos only**, one
  reachable incident, the same content-type allowlist and size cap as the editor upload, behind
  the same per-IP capture rate limit. A Beilage is report paperwork, which is what the poster
  is for; audio is deliberately not offered there.
- A link token exposes **one incident, read-only, for as long as that incident is open**: map,
  Pläne, Referenz-Layer, Personen, Verlauf and the live vehicle/weather display — what a
  `viewer` sees on screen, and nothing that writes, prints, generates a PDF or calls a paid
  service. The reachable routes are an allowlist (`LINK_ALLOWED` in
  `backend/app/auth/incident_link.py`), and every one of them that names an incident is
  additionally checked against the token's own incident, so a link to one Einsatz cannot read
  another. It lasts **until the Einsatz is closed, and at most 12 h**: the incident's state is
  re-checked on every request, so closing or archiving it revokes the link on phones that
  already have it open, and `incident_link_session_ttl` is only the backstop for an Einsatz
  nobody closes. Rotating `incident_link_key` invalidates every outstanding link at once.
