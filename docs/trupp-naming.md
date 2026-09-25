# Trupp naming and history – decisions of 2026-09-12

Design record for the Trupp identity, its display on every surface, and the crew history the
Rapport reconstructs from. Decided in review of the audit below; **implemented 2026-09-12** on
`claude/group-surveillance-display-audit-86w9ch` – this page is the spec the implementation is
judged against, and the «Where it lives» section at the end says where each decision landed.
Update it in the same change when a decision moves.

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
- Two devices that mint the same number at the same moment are settled by the merge
  (§7, 25.09.2026): one keeps it, the other takes the next free one, and the Verlauf says so.
- Registering from an unlinked chip **inherits the chip's number**. Linking a chip to an
  already-numbered Trupp relabels the chip to the Trupp's number.
- Field: `Trupp.no: number`. The chip's `text` stays a mirror copy, as today.

### 2. The leader stays the face of a Trupp on the board and map

People call a Trupp by its Gruppenführer, so on the Atemschutz card, the phone row, the
lite-board tab, the map/plan marker and the selected pill the **leader name stays primary**
(bold, colour dot, as today). The number is a **small badge** next to it, for documentation –
spelled `#1`, because a bare digit beside a name read as a count (12.09., after the first build).
Since 14.09. the badge sits on the **Atemschutz card only**: it left the phone row and the lite
tab strip first, then the resting Trupp marker on the Karte and the chip on the Plan, and the
selected pill with them – on the picture the name alone is the label.

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
- The journal vocabulary term is **`Trupp 1`** (deviation from the first draft's
  `Trupp 1 (Meier Anna)`: terms match whole substrings, and that form would never match a
  safety row's `Trupp 1 (Meier Anna / Dürring Jan)`). The crew behind it is marked as the people
  they are, each with their own Funktion; on a crew row the first person marked is badged `GF`.
  The composer's chip says `Trupp 1 · Meier Anna`. Old rows written as `Trupp Meier Anna` stay
  as written – the legacy term stays in the vocabulary beside the numbered one.

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

### 7. Two devices, one number: the merge settles it (25.09.2026)

The counter is not stored anywhere; every device derives the next number from what it can see
(`nextTruppNo`). Three devices on one login that tap «Neuer Trupp» inside one second each see
the same Einsatz, so each mints «Trupp 1», and the merge – per object – rightly keeps all three.
The first version of this page accepted that duplicate for OFFLINE devices; the field scenario
of 24.09.2026 (`e2e/field-scenario.spec.ts`) showed it with three devices ONLINE, and the fix
covers both, because nothing short of a server round-trip can stop the mint and a Trupp has to
be registrable offline.

- **Where:** at the end of every `mergeWorkspace`, after `trupps` and `objects` are merged
  (`lib/truppNumbers · resolveTruppNumbers`). The claimants of a number are the Trupps carrying
  it (removed ones included) and the UNLINKED chips labelled «Trupp N»; a chip bound to a Trupp
  is that Trupp's marker and wears its leader's name.
- **Who keeps it:** the one with the most record behind it – a Trupp that went in (Eintritt) over
  one that is only registered, a registered Trupp over a loose chip – then the one minted first
  (registration time off its first log row, which is on the deployment's clock; a chip's id
  timestamp), then the id.
- **The others** take the next numbers of the ONE counter, above everything anybody holds, in
  that same order – exactly as if they had been minted a moment later. A chip is relabelled on
  both of its bodies («Trupp 1» → «Trupp 4»), and the Karte's legacy views are derived again.
- **Convergence:** the function is pure over the merged record, so identical inputs give
  identical numbers on every device, and its output has no duplicate left for a later merge to
  act on – no ping-pong. Which number a loser gets can depend on the order the devices landed
  in; who KEEPS the number cannot.
- **The Verlauf:** ONE row per renumbering – «Trupp 1 (Meier Anna / Müller Hans) heisst jetzt
  Trupp 3» through `truppLogName` (copy `atemschutz.logRenumbered`), «Trupp 1 heisst jetzt
  Trupp 4» for a chip, `subjectId` = the Trupp / chip. No device can tell which of them minted a
  Trupp (a record carries no device id), so every device that was SHOWING the old number says it
  – `WorkspaceSync` diffs what the view held against what it is handed (a merge it resolved, a
  cold-reopen merge, a revision the live poll adopts) and `useIncidentSync` writes the row under
  the DERIVED id `trn-<id>-<from>-<to>`; the journal keeps the first and drops the rest. The diff
  runs on the state that reaches the view, not inside the merge, because a merge whose PUT 409s
  is merged again and may settle differently. A chip whose old number nobody holds afterwards
  was renamed by hand, not renumbered, and stays quiet as a rename always has.
- **What stays:** rows already written under the old number keep it (append-only); the renumber
  row is what connects the two. The Rapport's Atemschutz page reads the Trupp's own record – its
  readings and `crew` rows live inside it, keyed by nothing but the record – so it prints the
  current number with the whole history under it, and the printed journal still recognises the
  Trupp's rows by `subjectId`.
- **Undo:** a renumbering is a merge outcome, not an act. It reaches the view only through a
  hydrate, which drops the undo timeline (AGENTS.md · Undo/redo), and it pushes nothing on it.

## Out of scope

An explicit «Zusammenlegen» action; a Rapport section for `einfach` Trupps; renumbering by
hand.

Rows already written under the old number are not rewritten, and the Verlauf's vocabulary term
«Trupp N» (§4) marks a range by its number: after a renumbering, a row written under «Trupp 1»
is marked as whichever Trupp holds 1 NOW. The row's own crew in parentheses and the renumber row
say which crew it was. Revisit only if the field reads the marks wrongly.

«Registering from an unlinked chip inherits the chip's number» is not built. Since 14.09. a
register-from-chip path exists («Neuer Trupp» on the loose marker's join sheet), but it runs the
normal registration and then the normal join (`adoptTruppMarker`), so the Trupp takes the next
number from the counter and the chip is relabelled to it – one rule for every join, no second one
for this door. Revisit only if the field asks for the chip's number to stick.

## Where it lives

| Decision | Code |
|---|---|
| `Trupp.no`, the `crew` reading | `src/types.ts` |
| One counter, chip names included | `src/lib/placedTrupps.ts` · `nextTruppNo` / `nextTeamName`; fed from `IncidentWorkspace` (`placedTeamNames`) to `Whiteboard` and `useTeamMarkerActions` |
| Numbering on registration, crew rows on register / edit / transfer / re-entry, leader-only rows | `src/lib/useTruppActions.ts` · `createTrupp`, `crewRow` |
| Migration of unnumbered records | `src/lib/workspace.ts` · `numberTrupps`, applied in `deriveInitial` |
| Two devices, one number (§7) | `src/lib/truppNumbers.ts` · `resolveTruppNumbers` (called at the end of `mergeWorkspace`), `truppRenumberings` (diffed in `WorkspaceSync` · `reportRenumbered` → `onTruppRenumbered`), `renumberRow` (written by `useIncidentSync`) |
| Backend accepts `no` | `backend/app/alarm_validation.py` |
| The one crew formatter, both forms | `src/lib/atemschutz.ts` · `truppLogName(t, 'crew' \| 'leader')` |
| Vocabulary term `Trupp N` + legacy term, GF badge on the first person | `src/lib/journalLinks.ts` |
| The badge | `src/components/TruppNo.tsx` (`.trupp-no` in `02-base.css`), used on the card and `TruppFinder` (not the phone row, the lite tab strip, the resting map marker / plan chip, or the selected `TwinTeamPill` – all dropped 14.09.) |
| The join sheet of a loose chip | `src/components/TwinTeamPill.tsx` · `TruppJoinMenu` – the ONE list of Trupps a selected marker/chip can be joined to, on both surfaces; its last row «Neuer Trupp» opens the Anmeldung (`AtemschutzView · createRequest`) and the saved Trupp adopts the marker (`IncidentWorkspace · newTruppFromMarker / adoptMarkerA`) |
| Crew per cycle and the change lines | `src/lib/report.ts` · `truppCrewHistory`; payload in `reportPdfDirect.ts` (`no`, `leader`, `cycles`); rendered by `backend/app/report_pdf.py` (`TruppIn.cycles`, heading `Trupp N – Leader`) |

## Implementation order

1. Type + normaliser + counter (`Trupp.no`, `placedTrupps · nextTeamName` sharing it), chip
   inheritance on register/link. Backend `validate_trupp` accepts `no`.
2. `crew` reading written by register / edit / transfer / re-entry.
3. Journal templates and `truppLogName` / vocabulary term; separator unification.
4. Board, map, pill, finder, alarm row badges.
5. Rapport payload (`TruppIn.no`, `crewByCycle`, `changes`) and PDF rendering.
6. Docs: this page, `verlauf-coverage.md`, glossary.
