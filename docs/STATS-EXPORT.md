# Statistik-Export API – `GET /api/stats/incidents`

Read-only feed of every incident as one flat JSON record – for external analytics (e.g.
a yearly-statistics dashboard).

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
| `include_exercises=1` | also export Übungen (excluded by default; each record carries `is_exercise`) |
| `include_unconfirmed=1` | also export incidents no editor ever opened (excluded by default – see below) |

Response: JSON array, **oldest first**. Archived incidents are included (`is_archived`).

## What is *not* in the feed, and why

Since alarms started opening themselves (2026-08-02) an incident exists for **every alarm that
ever arrived** – test alarms, Nachbarhilfe, re-dispatches, an Einsatz-Link someone tapped for a
turnout the station never made. Those are not Einsätze, and this feed is what the canton's
figures are built from, so they must not be counted.

The line is `editor_opened_at` (exported as `confirmed_at`): stamped the first time an
authenticated **editor** opens the incident's workspace – «a KP tablet had this Einsatz».
Viewers and Einsatz-Link guests never stamp it, and it never advances, so it is a latch, not a
last-active tracker.

- **Confirmed** (`confirmed_at` set) → exported. Someone at the station worked the incident.
- **Unconfirmed** (`confirmed_at` null) → omitted, unless `include_unconfirmed=1`. Ask for them
  when you want the *alarm volume*; the Einsatz count is the default.

Übungen are excluded on the same principle (`include_exercises=1` to get them).

> **Upgrading:** the latch column landed on 2026-07-18 and older incidents never had one.
> The migration that introduced this filter backfills them from the evidence that a human was
> in the loop (human-created, or a synced workspace, or a completed Rapport), so a station's
> reported history does not change when it upgrades.

## Record fields

| Field | Type | Source / semantics |
|---|---|---|
| `id` | string (UUID) | incident id |
| `started_at` | ISO datetime | Alarmierungszeit – **read `started_at_source` before trusting it as one** |
| `started_at_source` | `"alarm"` \| `"manual"` \| null | provenance of `started_at`: stamped by the alerting system, asserted by a human, or **null = nobody supplied an alarm time and the value is the record-open time** |
| `created_at` | ISO datetime | when the record was opened in the app (`started_at → created_at` is the pick-up-the-tablet delay) |
| `closed_at` | ISO datetime \| null | stamped on first archive |
| `title`, `text` | string | Stichwort, Alarmmeldung |
| `kategorie` | string \| null | VKF Schadenkategorie (`incident.type`) |
| `priority` | `"HIGH"` \| `"LOW"` \| null | |
| `address`, `lat`, `lng` | string/number \| null | |
| `source` | string | `divera` \| `manual` \| intake slug \| `migrated` |
| `source_ref` | string \| null | the alerting system's own id for the **alarm** – what the intake deduplicates on. Not an incident id, and not a printed reference: for a Divera deployment it is a bare integer |
| `alarm_ref` | string \| null | the reference the alerting system **printed on the alarm** – the string that reaches the paper report and can be transcribed into a record system's case-number field. Null when nothing stated one. **Not unique per incident** – see below |
| `alarm_origin` | string \| null | where the alarm came **in** from, as the alerting system knew it – a slug like `alarmzentrale`, never a phone number. Recorded write-once at intake. Null means no origin was stated, which is the normal case and reads as *unknown*, **not** as "not a dispatch" – see below |
| `is_archived` | bool | |
| `is_exercise` | bool | Übung – only present when `include_exercises=1` asked for them |
| `confirmed_at` | ISO datetime \| null | first editor open (`editor_opened_at`); null = nobody at the station ever had this incident open |
| `rapport` | `open` \| `done` \| `changed` | derived: `changed` = anything moved after Rapport completion |
| `report_done_at` | ISO datetime \| null | |
| `alarmiertAt` | ISO datetime \| null | the **effective** Alarmierungszeit: the Rapport's own value if edited, else `started_at` when its provenance is known. Null when this record does not know one – see below |
| `ausgeruecktAt`, `endedAt` | ISO datetime \| null | Rapport times (`ausgeruecktAt` = first physical departure once vehicle milestones exist) |
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
  (`docs/ALARM-INTEGRATIONS.md` §1) and human-correctable – `manual: true` marks operator
  entries. Unknown ids are passed through verbatim.
- **The alarm time is the one field to check before joining on it.** Until 2026-08-02 only
  the generic `POST /api/alarms` intake ever recorded one: the Divera webhook, the poller's
  auto-open and the pool take all left `started_at` at its database default, so it held the
  moment the record was opened – off by minutes on a good day and by days on a bad one – and
  `alarmiertAt` was null on every record that had never been hand-edited. Both are fixed;
  `started_at_source` is how a consumer tells a repaired record from one that predates the
  fix. **Skip rows with `started_at_source: null` when the join keys on time** – their
  `started_at` is a record-open time, and the export refuses to launder it by publishing it
  as `alarmiertAt`. They are still real incidents and still count.
- **Matching against a record system (WinFAP and friends).** There is no shared id, so the
  baseline is `alarmiertAt` (not `started_at`) within a ±3 h window plus the address — and
  that baseline was *measured* over five closed years at **73%**, because a third of the
  incidents both systems hold disagree on one of those two fields. Free-text places are the
  reason: one side names a landmark, the other the nearest street, and no amount of
  normalisation bridges that. Report ambiguous and unmatched rows rather than picking the
  nearest one. Reference consumer: fwo-stats `kpfront_service.py`.

- **`alarm_ref` is how a station beats that**, and it costs no code here: print it on the
  paper report and type it into the record system's free case-number field, then join on it.
  Two properties of the field decide how a consumer must use it, and both are easy to get
  wrong:

  - **It is byte-for-byte the string the alerting system stated.** The export never trims,
    re-cases or reformats it, because the whole point is that the value printed on paper,
    the value here and the value typed into the record system are the same bytes.
  - **It is not an incident id.** Oberwil's is `fwo-sms-<12 hex>` derived from the *address*
    alone, so two incidents at the same place carry the same reference — measured at **52.9%**
    of Einsätze over eight years, with recurring false fire alarms the largest group. Match
    `alarm_ref` **inside the time window**, exactly like the fallback, and treat a repeated
    reference as ambiguous. Only 8 same-reference pairs in eight years fell within ±3 h, so
    the gate costs essentially nothing. What the reference removes is the *address*
    disagreement, not the need for a window.

  A consumer should also count how many rows it joined by `alarm_ref` versus by the time +
  address fallback. `alarm_ref` is null wherever no alerting system stated one, and a join
  that quietly falls back reports the same shape as one that works.

- **`alarm_origin` says where the alarm came *in* from**, which is a different question from
  every other provenance field here. `source`/`source_ref`/`alarm_ref` all identify *which*
  alarm; `alarm_origin` says *how it was raised*.

  It matters because an alerting system's sender allowlist usually holds more than the
  dispatch centre. At Oberwil it holds ten numbers – one landline and nine mobiles – so a
  dispatch and an SMS an officer sent by hand are equally allowlisted and otherwise
  indistinguishable once they arrive here. A consumer deciding whether an Einsatz may reach
  a **public surface** needs exactly that distinction, and it cannot be reconstructed later,
  which is why it is recorded at intake and never rewritten.

  **Null is not a negative answer.** It is what an unlabelled allowlist entry produces, what
  a fallback relay handling an alarm during an outage produces (it reaches the alerting
  system but not this app), and what any deployment whose alerting system sends no origin
  produces. Read it as *unknown*. A consumer that treats null as "not a dispatch" will drop
  real Einsätze, and it will drop them hardest during an outage — exactly when the record
  matters most.
