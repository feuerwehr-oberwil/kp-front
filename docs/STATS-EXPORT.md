# Statistik-Export API — `GET /api/stats/incidents`

Read-only feed of every incident as one flat JSON record — for external analytics (e.g.
a yearly-statistics dashboard). Design: [`planning/stats-integration.md`](planning/stats-integration.md) (interface C2).

## Auth

Station-level token, managed in the admin UI (**Datenquellen › Statistik-Export**:
activate / rotate / disable). Fail-closed: no token configured → every call answers
`403`; wrong/missing token → `401`. Strictly read-only; the token grants nothing else.

```bash
curl -H "X-Stats-Token: <token>" "https://<host>/api/stats/incidents?year=2026"
# token alternatively as ?t=<token>
```

## Parameters

| Param | Meaning |
|---|---|
| `year` (optional) | filter to one calendar year of `started_at`, evaluated in **Europe/Zurich** local time (a 31.12. 23:30 UTC incident counts in the new local year) |

Response: JSON array, **oldest first**. Archived incidents are included (`is_archived`).

## Record fields

| Field | Type | Source / semantics |
|---|---|---|
| `id` | string (UUID) | incident id |
| `started_at` | ISO datetime | Alarmierungszeit (Divera-stamped or backdated manual entry) |
| `closed_at` | ISO datetime \| null | stamped on first archive |
| `title`, `text` | string | Stichwort, Alarmmeldung |
| `kategorie` | string \| null | VKF Schadenkategorie (`incident.type`) |
| `priority` | `"HIGH"` \| `"LOW"` \| null | |
| `address`, `lat`, `lng` | string/number \| null | |
| `source` | string | `divera` \| `manual` \| intake slug \| `migrated` |
| `is_archived` | bool | |
| `rapport` | `open` \| `done` \| `changed` | derived: `changed` = anything moved after Rapport completion |
| `report_done_at` | ISO datetime \| null | |
| `alarmiertAt`, `ausgeruecktAt`, `endedAt` | ISO datetime \| null | Rapport times (`ausgeruecktAt` = first physical departure once vehicle milestones exist) |
| `einsatzleiter`, `kontaktperson`, `summary` | string \| null | Rapport fields |
| `eigentuemer` | string \| null | Eigentümer / Verursacher |
| `gerettete` | `{personen?, tiere?}` \| null | rescued counts (absent ≠ 0) |
| `rueckmeldungElz` | `{name?, at?}` \| null | report-back to dispatch |
| `partner` | `[{org, name?}]` | Partnerorganisationen |
| `gruppen` | `[{id, alarmedAt, manual?}]` | per-group alarm times; ids from deployment config `alarms.groups` |
| `fahrzeuge` | `[{id, ausgerueckt?, vorOrt?, zurueck?, manual?}]` | per-vehicle timeline; ids from `fleet.vehicles` (Traccar names) |
| `attendance` | `[{name, von, bis, status}]` | who was there, von–bis (hours are the consumer's derivation) |
| `mittel` | `[{label, menge, unit, source?}]` | current material totals (append-only log already collapsed) |

Notes for consumers:

- **No workspace blob, no map data** ever appears in this feed.
- `gruppen`/`fahrzeuge` are prefilled by the alarm pipeline's milestone webhook
  (`docs/ALARM-INTEGRATIONS.md` §1) and human-correctable — `manual: true` marks operator
  entries. Unknown ids are passed through verbatim.
- Matching against WinFAP exports: no shared id — match on `started_at` within a ±3 h
  window (reference consumer: fwo-stats `kpfront_service.py`).
