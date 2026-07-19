# Alarm integrations: inbound intake & outbound webhooks

*Status: shipped 2026-07-08. How alarms get **into** KP Front from any alerting system, and how
incident-created events get **out** to whatever a station wires up (slip printers, chat bots,
pagers). KP Front core stays printer- and vendor-agnostic; everything here is config.*

## The pieces

```
alerting system ──POST /api/alarms──► KP Front ──alarms.webhooks──► your adapter (printer/bot/…)
      (or Divera webhook/poll)           │
                                         └── auto-opens the incident; the Erfassungs-Poster
                                             (/e/<token>) reaches it for captureWindowHours
```

## 1. Inbound: generic alarm intake — `POST /api/alarms`

For stations **not** on Divera (which has its own integration), or for scripts/dispatch
systems. Every accepted alarm **auto-opens an incident** — this endpoint *is* the auto-open
for third parties, so it is not gated by `alarms.autoOpen`.

- **Auth:** `ALARM_WEBHOOK_SECRET` env var, sent as `?secret=` or `X-Webhook-Secret`.
  Fail-closed: unset → 403 for everyone. Setting it is the opt-in.
- **Idempotent:** one incident per `(source, source_id)` — a retried delivery returns the
  existing incident (`200`, `"created": false`) instead of duplicating it.
- `type`/`priority` fall back to the same keyword inference the Divera path uses.
- `source` is a short slug naming the upstream (`leitstelle`, `pager`, …); `manual`,
  `migrated` and `divera` are reserved.

```bash
curl -X POST "https://front.example.org/api/alarms?secret=$ALARM_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "leitstelle",
    "source_id": "E-2026-0815",
    "title": "BMA Alarm Industriestrasse",
    "address": "Industriestrasse 5, 4104 Oberwil",
    "lat": 47.514, "lng": 7.558,
    "priority": "HIGH"
  }'
# → 201 {"incident_id": "…", "created": true}
```

### Milestone enrichment — `POST /api/alarms/milestones`

The alarm pipeline can push per-group alarm times and per-vehicle Ausrück/Vor-Ort/Zurück
times as they happen (e.g. derived from GPS geofence events). Same secret as the intake;
targets an existing incident by `divera_id` **or** the intake's `(source, source_id)` pair —
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
    "groups":   [{ "id": "g2",  "alarmedAt":  "2026-07-13T01:12:00Z" }],
    "vehicles": [{ "id": "tlf", "ausgerueckt": "2026-07-13T01:16:40Z" }]
  }'
# → 200 {"incident_id": "…", "applied": 2}   (replay → "applied": 0)
```

## 2. Outbound: incident-created webhooks — `alarms.webhooks`

Deployment config (`docs/CONFIGURATION.md` §1):

```jsonc
"alarms": {
  "webhooks": ["https://printer-adapter.local/kp-front"]
}
```

Every incident creation (manual wizard, Divera take, Divera auto-open, generic intake)
POSTs this JSON to each URL — **fail-open**: retried (0s/2s/8s), logged, never blocking or
delaying intake:

```jsonc
{
  "event": "incident.created",
  "incident": {
    "id": "…", "title": "BMA Alarm Industriestrasse",
    "type": "BMA / unechte Alarme", "priority": "HIGH",
    "address": "Industriestrasse 5, 4104 Oberwil",
    "lat": 47.514, "lng": 7.558,
    "source": "leitstelle", "started_at": "2026-07-08T14:32:00+00:00",
    "auto_opened": true
  },
  "capture_url": "https://front.example.org/e/<token>"   // null unless PUBLIC_URL is set
                                                          // AND the Erfassungs-Poster is active
}
```

Set `PUBLIC_URL` (env) to the deployment's public origin so `capture_url` can be composed.

### Example adapter: kp-rueck thermal QR slip

If the station runs [kp-rueck](https://github.com/feuerwehr-oberwil/kp-rueck) with its print
agent, a per-alarm slip (times + capture QR) is a few lines — kp-rueck's existing
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
    async with httpx.AsyncClient() as c:   # add kp-rueck auth as configured there
        await c.post(f"{KP_RUECK}/api/print/qr-code",
                     json={"content": url or inc["id"], "label": label})
    return {"ok": True}
```

## 3. The Erfassungs-Poster (station capture)

Independent of any printing: the admin UI (Personen › Erfassung) prints a **static A4
poster** for the Magazin wall. Scanning it opens `/e/<token>` — attendance, material,
Einsatzende and notes for incidents of the last `alarms.captureWindowHours` (default 12),
no login. Trust model: access to the station = permission, like the clipboard it replaces.
Rotate the token in the admin UI to invalidate every printed poster at once; delete it to
turn the surface off (fail-closed).

## Security notes

- All three secrets are independent and fail-closed: `ALARM_WEBHOOK_SECRET` (inbound),
  the poster token (capture), `ADMIN_SECRET` (administration).
- Outbound webhook URLs are admin-set config, pinned to `http(s)`; the payload contains the
  capture URL (a capability) — point webhooks only at receivers you trust.
- The capture surface can only touch open incidents inside the window, and only
  attendance/material/journal/Einsatzende — no map, no admin, no history.
