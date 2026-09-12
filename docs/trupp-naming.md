# Trupp naming and history – decisions of 2026-09-12

Design record for the Trupp identity, its display on every surface, and the crew history the
Rapport reconstructs from. Decided in review of the audit below; **not yet implemented** – this
page is the spec the implementation is judged against. Update it in the same change when a
decision moves.

## Why

An audit of every place a Trupp is shown found that a Trupp has **no name of its own**:
`Trupp.name` is the Gruppenführer's name (`src/types.ts`), there is no number and no label,
and there is no history of crew composition. Every surface therefore derived its own display
from the leader plus the current `members` array, which produced sixteen distinct styles and
three separators for the same crew, and a Rapport whose Atemschutz page is a **snapshot of the
current state** (`src/lib/reportPdfDirect.ts`): a leader change or a transfer mid-incident is
visible only as free text in the printed journal, and that text carries no Trupp reference.

## Decisions

### 1. Identity: `Trupp N`, one sequence per incident

- Every Trupp gets a number on registration: `Trupp 1`, `Trupp 2`, … in registration order.
- **One counter** across Atemschutz and `einfach` Trupps **and** unlinked Plan/Lage chips. Two
  things on the same incident are never both called `Trupp 1`.
- Numbers are never reused, not after deletion, not after re-entry.
- Registering from an unlinked chip **inherits the chip's number**. Linking a chip to an
  already-numbered Trupp relabels the chip to the Trupp's number.
- Field: `Trupp.no: number`. The chip's `text` stays a mirror copy, as today.

### 2. The leader stays the face of a Trupp on the board and map

People call a Trupp by its Gruppenführer, so on the Atemschutz card, the phone row, the
lite-board tab, the map/plan marker and the selected pill the **leader name stays primary**
(bold, colour dot, as today). The number is a **small badge** next to it, for documentation.

- Hose-line end tag stays the abbreviated leader («Meier A.»); no number.
- Alarm row, finder and card crew line list the crew with the same separator as the journal
  (§4).

### 3. Crew history: `crew` readings in the append-only log

`TruppReading` gets a new kind `crew` carrying `{ name, members }` at that moment.

- Registration writes the first one; every crew edit, leader change, `transferOutOfTrupp`
  (both Trupps) and re-entry writes another.
- The readings log is already merged field-by-field in `mergeWorkspace · mergeReadings`, so
  concurrent devices need no new rule.
- No merge action. Merging two Trupps is the existing **transfer-one-person** path, repeated;
  the emptied Trupp is deleted as today. The Rapport tells both stories from the readings.
- `Trupp.name` / `Trupp.members` remain the **current** crew for the live board.

### 4. Verlauf rows

- Every Trupp row starts with the label and the leader: `Trupp 1 (Meier Anna): …`.
- **Safety rows** (angemeldet, Eintritt, Kontakt, Druck, Rückzug, Austritt, Alarm, Wieder
  einrücken) spell out the whole crew: `Trupp 1 (Meier Anna / Dürring Jan): Eintritt`.
- **Housekeeping rows** (platziert, Farbe, Leitung, bearbeitet, gelöscht, wiederhergestellt,
  nicht mehr gesetzt) name the leader only: `Trupp 1 (Meier Anna): Farbe geändert`.
- The crew separator is **« / » everywhere** – journal, card crew line, alarm row, finder.
  Comma stays reserved for role lists («Unter AS: …»). `truppLogName` is the one formatter.
- The journal vocabulary term becomes `Trupp 1 (Meier Anna)` so auto-linking and the
  role suffix `(AS-GF)` keep working; old rows written as `Trupp Meier Anna` stay as written.

### 5. Rapport, Atemschutz page

Per Trupp:

- Heading `Trupp 1 – Meier Anna` (label plus leader **at registration**).
- Under it, **per deployment cycle** (each Eintritt/Austritt pair from the readings, as
  `truppRunTimes` already computes) the crew that went in, from the latest `crew` reading at
  or before the Eintritt.
- Crew changes as **dated lines** in the cycle they happened in:
  `14:32 Gruppenführer Meier Anna → Keller Andreas`, `14:40 Dürring Jan → Trupp 2`,
  `14:40 Frei Nina von Trupp 1`.
- `einfach` Trupps still have no page of their own (unchanged, open question).

### 6. Migration

Records without `no`: a client-side normaliser in `workspace.ts` numbers unnumbered Trupps by
their first reading's timestamp (registration time) on load and the next write persists it.
Closed incidents render with the same rule and are not rewritten. Old journal rows stay as
written; the printed journal is a record, not a view.

## Out of scope

An explicit «Zusammenlegen» action; a Rapport section for `einfach` Trupps; renumbering.

## Implementation order

1. Type + normaliser + counter (`Trupp.no`, `placedTrupps · nextTeamName` sharing it), chip
   inheritance on register/link. Backend `validate_trupp` accepts `no`.
2. `crew` reading written by register / edit / transfer / re-entry.
3. Journal templates and `truppLogName` / vocabulary term; separator unification.
4. Board, map, pill, finder, alarm row badges.
5. Rapport payload (`TruppIn.no`, `crewByCycle`, `changes`) and PDF rendering.
6. Docs: this page, `verlauf-coverage.md`, glossary.
