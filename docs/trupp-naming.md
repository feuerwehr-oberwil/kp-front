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
- **Who keeps it:** the one with the most record behind it, then the one the server's copy
  already holds under that number (`landed` – it is on every screen that polled it, and in the
  rows written since), then the one minted first (registration time off its first log row, which
  is on the deployment's clock; a chip's id timestamp), then the id. «Most record», highest
  first: a Trupp ON the board that went in (Eintritt) · one on the board that is only registered
  · the same two taken OFF the board (`removedAt` – still on the Rapport, but nobody calls it any
  more) · a loose chip. So at equal weight the first to LAND keeps the number, and a claim that
  arrives later – minted earlier, but offline or in a merge that had not landed – takes the next.
- **One move per collision** (N16 of the staging walk-through, 25.09.2026). A merge that 409s is
  merged again from its own result, and the number it had just handed out used to come back as a
  CLAIM: «Trupp 1» stood, three devices minted «2», two merges ran against the same server copy
  and both handed out 3, and the second to land moved the first one's Trupp again, 3 → 4 – on
  paper two crews «were» Trupp 3. Now each merge first takes back this side's un-landed
  renumberings (`truppNumbers · unwindUnlanded`: `formerNos` beyond the server copy's, on a Trupp
  whose number differs from it), so the Trupp is back at the number its device showed and moves
  once, straight to where it ends (2 → 4); and a landed number stays with its holder at equal
  weight. A number enters `formerNos` only once it was on the server.
- **The others** take the next numbers of the ONE counter, above everything anybody holds or
  held, in that same order – exactly as if they had been minted a moment later. The counter reads
  every Trupp's number and former numbers, every chip, and every ghost trail («Spur»), deleted ones
  included: a deleted chip that left a Spur used its number. A chip is relabelled on both of its
  bodies («Trupp 1» → «Trupp 4»), and the Karte's legacy views are derived again. A Trupp keeps
  what it lost in `Trupp.formerNos`.
- **Convergence:** the function is pure over the merge's inputs: identical INPUTS give identical
  numbers on every device, and the output has no duplicate left for a later merge to act on – no
  ping-pong. It is NOT independent of timing: which number a loser gets, and at equal weight who
  keeps it, follow the order the devices landed in; the first result to land settles it, and a
  Trupp moves again only if a later claim outweighs it (a crew that went in).
- **The offline case, honestly:** a device that was offline and sent its Trupp in (Eintritt)
  before reconnecting outranks an online Trupp that is on the server but has not gone in yet. On
  reconnect the ONLINE Trupp is renumbered, although the crew may have been called by that number
  on the radio for as long as the other device was away. That is the trade: the crew that is
  inside keeps the number its Atemschutz-Journal is written under. If both went in, the one on the
  server keeps the number, and the offline one's whole journal so far stands under a number
  that is now another crew's – the renumber row and `formerNos` (below) are what make that
  readable afterwards, not what prevents it.
- **What each session may settle:** only what its push can carry (`WorkspaceSync ·
  numberScope`). A full editor settles everything. The Atemschutz-Link pushes the `trupps` slice,
  so it settles Trupps among themselves and never a chip: a chip it relabelled would never reach
  the server, and the next poll would hand the old label back («1 → 2», then «2 → 1»). The `el`
  role pushes neither and settles nothing – it reports a renumbering only from a revision it
  adopts.
- **The Verlauf:** ONE row per renumbering – «Trupp 1 (Meier Anna / Müller Hans) heisst jetzt
  Trupp 3» through `truppLogName` (copy `atemschutz.logRenumbered`), and for a chip by the labels
  it wore («Trupp 1 heisst jetzt Trupp 4», `atemschutz.logRenumberedChip`), `subjectId` = the
  Trupp / chip, under the DERIVED id `trn-<id>-<from>-<to>`, so every device that says it writes
  the same row and the journal keeps one. No device can tell which of them minted a Trupp (a
  record carries no device id), so it is said from three places (`WorkspaceSync ·
  reportRenumbered`):
  - what the view showed against what it is handed – a merge it resolved, a cold-reopen merge, a
    revision the live poll adopts. «What the view showed» is the content that 409'd AND the
    view's latest save: a Trupp registered while the merge PUT was in flight is in the second
    only;
  - by the RESOLVING device, once its push is accepted, for every number it changed of the
    server's copy – the device that minted it may be a Link, or reopen later from a clean cache
    and adopt the server copy with nothing to compare;
  - the Atemschutz-Link writes these rows too (`useIncidentSync · appendTeamRow`, a `team` row –
    the one kind the server takes from a link). A session nobody listens to holds each change once.

  The diff runs on states that reach the view or the server, never inside the merge, because a
  merge whose PUT 409s is merged again and may settle differently. A chip whose old number nobody
  holds afterwards was renamed by hand, not renumbered, and stays quiet as a rename always has.
- **What stays:** rows already written under the old number keep it (append-only); the renumber
  row is what connects the two. The Rapport's Atemschutz page reads the Trupp's own record, so it
  prints the current number with the whole history under it, and its heading names the first
  number too: «Trupp 3 (zuerst Trupp 1) – Meier Anna» (`formerNos`, backend `report_pdf ·
  _trupp_heading`). In the Verlauf a row ABOUT the Trupp (`subjectId`) marks its «Trupp 1» as
  THIS Trupp, by id, with what it is called now on the mark (`journalLinks · former`); anywhere
  else «Trupp 1» is whoever holds 1 now, and typing it completes to that one.
- **A ghost follows its Trupp:** a ghost trail keeps a copy of the number it was ghosted under,
  so its label reads through the live Trupp when it still exists (`truppTrails ·
  ghostTrailLabel`).
- **One device never needs the merge:** a duplicate one device could see coming is refused or
  re-minted where it happens, not left for an unrelated 409 to settle – ⌘D on a loose «Trupp N»
  mints the next number, a hand rename to a number somebody holds is refused with a toast
  (`whiteboard.teamNameTaken`), and a Spur revived under a number handed out since comes back as
  the next one (`placedTrupps · counterNames / teamNoTaken / freshTeamLabel`).
- **Undo:** a renumbering is a merge outcome, not an act. It reaches the view only through a
  hydrate, which drops the undo timeline (AGENTS.md · Undo/redo), and it pushes nothing on it.

## Out of scope

An explicit «Zusammenlegen» action; a Rapport section for `einfach` Trupps; renumbering by
hand.

Rows already written under the old number are not rewritten. The printed journal marks by the
number as it always did (bold either way); only the screen resolves a row's «Trupp N» by its
`subjectId`.

A chip deleted WITHOUT a Spur leaves nothing in the record but its Verlauf row, so the counter
cannot see its number and may hand it out again – as it could before 25.09.2026. A stored
high-water mark would close that; it is a schema change nobody has asked for.

«Registering from an unlinked chip inherits the chip's number» is not built. Since 14.09. a
register-from-chip path exists («Neuer Trupp» on the loose marker's join sheet), but it runs the
normal registration and then the normal join (`adoptTruppMarker`), so the Trupp takes the next
number from the counter and the chip is relabelled to it – one rule for every join, no second one
for this door. Revisit only if the field asks for the chip's number to stick.

## Where it lives

| Decision | Code |
|---|---|
| `Trupp.no`, the `crew` reading | `src/types.ts` |
| One counter, chip names included | `src/lib/placedTrupps.ts` · `nextTruppNo` / `nextTeamName` (former numbers included); fed from `IncidentWorkspace · truppCounterNames` (every chip, every ghost trail, every Trupp ever registered) to `Whiteboard`, `useTeamMarkerActions` and `useTruppActions` |
| Numbering on registration, crew rows on register / edit / transfer / re-entry, leader-only rows | `src/lib/useTruppActions.ts` · `createTrupp`, `crewRow` |
| Migration of unnumbered records | `src/lib/workspace.ts` · `numberTrupps`, applied in `deriveInitial` |
| Two devices, one number (§7) | `src/lib/truppNumbers.ts` · `resolveTruppNumbers` (called at the end of `mergeWorkspace`, scoped by `WorkspaceSync · numberScope`), `truppRenumberings` (diffed in `WorkspaceSync` · `reportRenumbered` → `onTruppRenumbered`), `renumberRow` (written by `useIncidentSync` · `appendTeamRow`); `Trupp.formerNos` → Rapport heading (`report_pdf · _trupp_heading`) and the Verlauf's link by id (`journalLinks` · `former`, `MarkOptions.subjectId`) |
| One device never needs the merge (§7) | `src/lib/placedTrupps.ts` · `counterNames`, `teamNoTaken`, `freshTeamLabel`; `IncidentWorkspace · truppCounterNames / teamNameTaken` (⌘D, ghost revival, the Karte's rename), `Whiteboard` (⌘D, rename pen) |
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
