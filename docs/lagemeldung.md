# Lagemeldung auf Knopfdruck – the composer and the Führungsrhythmus

**Status:** 🟡 built 2026-10-09 (F3, layout ★A «Zeilen-Entwurf»), draft for owner review on staging
**Audience:** whoever changes a rule, the anchor, the rhythm, or the backend's push sweep

A deterministic composer that reads the record, decides what matters right now, says what changed
since the last Lagemeldung, and fits it into one radio call – paired with a Führungsrhythmus that is
nothing but a chain of ordinary Wiedervorlagen. No AI: the same Saved + Verlauf give the same draft
on every device. The rules themselves are documented in the header and the rule functions of
[`src/lib/lagemeldung.ts`](../src/lib/lagemeldung.ts); this page holds what spans modules.

## The pieces

| Piece | Where |
| --- | --- |
| Engine: facts → diff → budget, pure | `src/lib/lagemeldung.ts` (+ `.test.ts`, the three moments of the design as fixtures) |
| Anchor finder, booking ids, rhythm state, chip state | `src/lib/lageRhythm.ts` |
| Composer sheet + Funkansicht (lazy chunk) | `src/components/LagemeldungSheet.tsx` |
| TopBar chip (tablet) · Einsatz-Menü row (phone) | `TopBar · LageChip`, `panels/IncidentSwitcher` |
| Due row [Lagemeldung] [+10′] | `ReminderBanner · DueLagemeldung` |
| Offer in the Eintrag composer | `JournalComposer · onLagemeldung` («Lagemeldung an Einsatzzentrale» typed) |
| Station default | deployment config `journal.lageRhythmMin` (admin › Rapport › Textbausteine), national 20′ |
| Server push of a due booking | `backend/app/push.py · due_reminders` |

## The anchor is a Verlauf row

«Gemeldet» appends ONE ordinary journal row: `text` is the Lagemeldung as said («Lagemeldung 21:37:
Zuerst: … Lage: …», one line, printed on the Rapport as it stands), and `lagemeldung` carries the
fingerprint of every fact that was said – values, not hashes – plus the facts the EL deliberately
unticked (`declined`). The newest non-retracted row carrying one is the anchor the next draft diffs
against. No per-device state, no `Saved` field (so no `MERGE_POLICY` row): the journal outbox
carries it offline like any row. «Rückgängig» / ↶ retract the row (append-only, a patch), and the
anchor falls back to the one before.

What the anchor stores: said facts; facts hidden because they were unchanged (carried forward from
the previous anchor – they are still what was reported); declined facts with their current value.
Never stored: facts the budget pushed out, tier-3 offers, events (a wind shift, a Nachalarm) – never
said, they get another chance.

## The rhythm is a chain of Wiedervorlagen

- Unless «Übergabe» or «keine» was picked, «Gemeldet» also appends one `created` reminder row with
  `purpose: 'lagemeldung'`, `intervalMin`, and an id **derived from the anchor row**: `lgm-<rowId>`.
- ⚠️ **Only the booking of the newest anchor is open.** A later Lagemeldung supersedes the earlier
  booking without a done row. The rule lives in three places that must agree:
  `lib/reminders · deriveReminders` (via `lageRhythm · currentLageReminderId`),
  `backend/app/push.py · due_reminders` (`_current_lage_booking`, which also honours retraction
  patches, latest one wins), and `lib/report · pendenzRows`, which does not print bookings among
  the Pendenzen at all.
- Before the first Lagemeldung nothing is written: the first «Lagemeldung fällig» is DERIVED,
  `firstAfterVorOrtMin` (5′) after the first vehicle is vor Ort (Rapport clock or the server's
  GPS arrival), id `lgm-start`. It rings in the foreground and stands in the Meldeleiste
  (`useReminders · derived`); the server's push does not know it until «+10′» writes it.
- «Rhythmus ausschalten» (the composer's ⋯) appends a `done` row on the current booking id; undo
  retracts that row. Any later booking starts it again.
- Only `editor` and `el` see any of it, and only on a running Einsatz.

## Decisions taken while building (owner left the three open questions to the defaults)

1. The rhythm starts by itself (5′ after the first vehicle), station default 20′, per Einsatz
   10 / 20 / 30 / Übergabe / keine in the composer.
2. Fixed slot order and labels from the copy (Zuerst · Lage · Menschen · Gefahren · Massnahmen ·
   Mittel · Bedarf · Zusatz · Nächste) – configurable wording, not structure.
3. The LLM «Glätten» seam is kept as structure only (`composeLagemeldung` returns lines with key,
   slot, tier, change, text) – no button, no endpoint.

## Not built / later

- L1 (Atemschutznotfall) waits for F1 (PR #300): a Trupp in Notfall is a tier-0 fact then.
- G5 reads the Gebäude-Steckbrief (F5) the workspace already fetched; without it the Gefahren
  slot holds what is on the map.
- The Rapport's «Rückmeldung an die ELZ» is not prefilled from a sent Lagemeldung.
