# Undo and redo

The one undo timeline: the rule, how an act joins the timeline and what a remote merge does to
it (`lib/undoTimeline`, `lib/undoKeys`). Moved here from AGENTS.md on 2026-10-08 (the rule on
2026-10-18), wording unchanged.

## The rule

- **Undo/redo – every mutating op should be undoable, scoped to the workspace.** ONE
  chronological timeline for the whole Einsatz (`lib/undoTimeline`), driven by the TopBar's ↶ ↷
  and by Cmd/Ctrl+Z on every surface – so «take back the last thing that happened» never asks
  which surface you are standing on. Three ways to join it – delegating, closure and grouped –
  and the choice is decided by what the domain already owns (below, with what a remote merge
  does to the timeline). An act the timeline holds raises no toast (owner pick 28, 17.11.2026).
  Deliberately NOT undoable: append-only records (Verlauf rows, audit events – corrections are
  new appended rows), device preferences (Ebenen, Einstellungen sheet) and server-side incident
  metadata (`PATCH /incidents`). Add undo for new mutations; don't skip it.
  (One door into that metadata has its own inverse: taking an «Alarm aktualisiert» – its toast's
  «Rückgängig» puts the old values back server-side and writes the counter-row, `backend/app/alarm_update ·
  undo`. It is not on the ↶ timeline, like the rest of the Einsatzdaten.)

## One delete rule

Owner, 13.11.2026 (sweep CTL.1 / CTL.2 / FLOW.2, «one rule everywhere»): **a removal the ↶
timeline or an inverse can bring back acts at once; a red ConfirmCard stands only where nothing
brings it back.** What happens after a delete depends on whether it can come back, never on what
was deleted. Since owner pick 28 (17.11.2026) a removal ON the ↶ timeline **says nothing**: the
object leaving the screen is the confirmation, the top bar's ↶ «Rückgängig» is the way back, and
a toast beside it only doubled the ↶ (docs/ui-conventions.md › «The toast rule»).

- The act lays its own step (any of the three ways below) and nothing else – `lib/removal` holds
  only the words and the joined-lines card. One step gives back the object, every Leitung end on
  it, a docked placard's bond, a sheet anchor, a page's writing — nothing re-implements an
  inverse. Until 17.11.2026 a helper (`removeWithUndo`) and the one-shots' closure toast
  (`oneShotUndoToast`: a Geschoss, a Gebäude swap, a Beilage) raised «… entfernt · Rückgängig».
- The ↶ caption is the removal's own Verlauf words, the object's name in it, and the Leitungen it
  set loose are counted («TLF entfernt, 2 Leitungen gelöst», `removedText`); a Notiz is «Notiz
  entfernt» (`stepLabelRef` / `onStepLabel`).
- A Karte step whose writer set no words names itself when it changed ONE object («TLF
  verschoben», `lib/undoStepWords`, owner pick UX journeys M·11, 25.11.2026); wider steps keep
  «Änderung auf der Karte». On the press the caption rings that object on the Karte and stays
  until the records' sync status says the step is on the server, then shows «✓ gespeichert»
  (`lib/undoFlash`). The head stays silent while all is well (round 2b, 13.11.2026).
- Under the rule (no ConfirmCard since 13.11.): a symbol, Form, Notiz (written or not), line,
  Fläche, Absperrkreis, a Mehrfach group — Lage and Plan alike (Leitungen attached: the one
  exception below);
  «Marker und Spur entfernen», «Spur entfernen» (marker, chip, Geister-Spur); a Teilstück's «E»
  letting its lines go; a saved Ansicht; a Tafel page or row; a Geschoss; a Gebäude replaced; the
  Passung's points and «Referenz zurücksetzen» on an Einsatz's own binding; a Leitung end's ✕
  «Verbindung lösen» (Lage and Plan), a symbol's free field ✕, a Rapport Partnerorganisation's
  bin, a Beilage, a Mittel line, a Trupp, a Zeitplan shift or band, an Anwesenheits-Block. Outside
  the timeline a removal keeps its confirm-with-undo toast with its own inverse, because it is the
  only way back: a cleared transcript section and a retracted Verlauf row (append-only patches),
  the Rapport poster's Beilage, Partnerorganisation and a count taken to 0 (the poster has no ↶),
  an Objektbesuch's photo and proposal.
- The ConfirmCard stays where nothing brings it back: Einsatz löschen, Link widerrufen, Besuch
  verwerfen, the Atemschutz Notfall, the Abschluss checks, admin (peacetime) — and the Passung
  of a STATION sheet, which saves to the station (`GeorefQuality · undoable`). The Atemschutz
  «Überwachung aus» on a Trupp inside is a safety call, not a delete, and keeps its card. The
  press-and-hold on a line / Messen node (`lib/nodeHold`) is a gesture, not a confirm, and stays.
- ⚠️ **The one exception: Leitungen hang on it** (owner, 14.11.2026 – «when deleting a symbol that
  is joined with a line … ask … if the connected part should also be deleted or not»). A symbol,
  Form, Notiz or Trupp – or a Mehrfach group – with Leitungen on it that are not themselves going
  asks first: «TLF hat 2 Leitungen» · [Abbrechen] [Mit Leitungen] [Nur Symbol] (the group: «Auswahl
  hat … Leitungen», «Nur Auswahl», the lines counted over all of it). It asks because the answer
  is a CHOICE of what goes, not a doubt about the delete: «Nur Symbol» is the rule's act (the ends
  let go where they stood, «TLF entfernt, 2 Leitungen gelöst»), «Mit Leitungen» removes every line
  on it as well, one at its other end on another symbol included («TLF und 2 Leitungen
  entfernt»). Either answer is ONE ↶ step, so it is still no red card.
  Nothing joined → no card, exactly as above. `lib/removal · askJoinedLines`,
  `lib/lineAttachments · linesOnObjects`; Lage `workspace/useMapActions · deleteEntity /
  deleteGroup`, Plan `components/usePlanRemoval` – the Delete key and every 🗑 go through them.
- Records that are not on the picture keep «gelöscht» in their words (`copy/removalWords.test.ts`).

## How an act joins the timeline

One act spanning several domains uses `UndoTimeline.group`. A dropper (`push`'s return) removes the
recorded group from either stack, including a group reduced to one part before it closed.

- *Delegating* – the domain keeps its own history and the entry calls it: the Karte's document
  (`useUndoableDoc` through `useObjectStore`), a Plan's per-document history (`useBoardDoc`),
  and the synced slices (`useUndoableSlice` – Anwesenheit, Mittel, Checklisten, **Rapport**,
  **Zeitplan**). Always through a **ref**: the entry outlives the render that pushed it.
- *Closure* – the entry carries its own inverse, for a domain with no stack: the
  Atemschutz-Tafel, the Gebäude one-shots (floor add/remove, building replace, Drehung),
  Rapport-Beilagen, Ansichten (`rememberOneShot`), a Pendenz corrected on the Tafel's «Aufträge /
  Pendenzen» page (its inverse is another appended correction, `workspace/useTafelPendenzen`).
- *Grouped* – one act over the Tafel and the Checklisten (05.11.2026, `lib/problemLink`): a
  problem's Tendenz set on a page writes the checklist's, a checklist problem deleted on a page un-ticks
  it – the board write and the slice write are ONE step (`UndoTimeline.group('plan')`,
  `usePlanTafelPages · editPage`); its ↶ caption says when a tick went with a deleted row. The
  same plain group holds a symbol card's commit and the Anwesenheit filing it causes (26.11.2026,
  sweep #27 B): a rename re-files its Fahrer, a named roster field files its person, and ONE ↶
  gives back the name and the Bemerkung together (`MapDetailPanels · patchSelected`, `Whiteboard ·
  patchSymbol`, through `undoGroup`). Not the compound below on the Plan: inside one, the store
  takes the sheet's step and its ↶ would name the Karte.
- *Compound* – one act over the picture and its bookkeeping (24.11.2026, `workspace/compoundStep`):
  a hose drawn or an end snapped onto a crew marker together with the Trupp link it makes, a
  Gebäude-Drehung with its re-glued marks. One group, and in it ONE store step — the first one
  laid; a plan step inside is taken by it (`usePlanStacks · takeIntoStore`), and the link's own
  picture step is skipped, or silent outside an act (its Trupp half writes the counter-row). The
  store step restores from the live state, sheets included; a plan step beside it replayed a
  stale sheet view on ↷ and cleared the store's redo mid-group.
- *No confirm-with-undo toast beside the timeline* (owner pick 28, 17.11.2026). Until then a
  one-shot that destroyed something (a Geschoss, a Beilage, an Anwesenheits-Block, a Pendenz's
  «Erledigt», the Abschluss with «Wieder öffnen») also raised a toast that did the inverse and
  dropped its entry. Now the ↶ is the one door; the Abschluss's way back is «Alle Einsätze» →
  «Wieder öffnen». A one-shot's ↶ writes its OWN counter-row (25.09.2026, `rememberOneShot`'s
  `rows`): a restored storey says «Geschoss 3. OG wiederhergestellt» beside «… entfernt» on the
  printed Einsatzjournal. The Rapport prints the ↶ / ↷
  rows as well (`report · journalRows`) — a taken-back act is two rows, on paper too. ⚠️ And a
  counter-row exists only beside the row it counters (26.09.2026): a one-shot whose act wrote
  no row undoes silently (`rememberOneShot(…, 'silent')`), and a ↶ of an act the paper does not
  print (a move) is not printed either (`report · historyCountersPrintedRow`).
Two rules that fall out of it: a surface that persists on every **keystroke** classifies its
writes so a burst of typing is ONE step and a value/row appearing or disappearing is its own
(`lib/reportUndo`, `UndoableSlice.set`'s `coalesce`); and a remote hydrate closes the open
fold windows — the Rapport's typing burst (`lastReportStep`), the Bildlegende
(`lastCaptionStep`) — and re-opens a plan gesture whose
step the merge took: the store's sheet-step token (`useObjectStore · rebaseObjects`) and the
Whiteboard's first-movement checkpoint (`useBoardDoc · set`) each lay a fresh step at the
gesture's next sample.
- ⚠️ **A remote merge drops only the steps it INVALIDATED** (25.09.2026, `lib/undoKeys`,
  `UndoTimeline.rebase`) — this REVERSES the 08.09. rule that dropped the whole timeline on
  every hydrate, which with three devices greyed ↶ out within ~2 s of any save anywhere.
  `applyWorkspace` diffs the live state against the merged one record by record, at or coarser
  than the merge's own granularity (`WORKSPACE_RECORDS`: an object/Trupp/Mittel row by id, an
  Anwesenheit by person, a Rapport field by name, `building:` whole; `planview:<planId>` for a
  sheet whose drawn view moved, `planview:*` when a fit field did). The diff is by value and
  insensitive to key order ONLY (an `undefined` property counts as absent): array order and
  every value are compared exactly — the merge's own comparison (`undoKeys · sameValue` IS
  `lib/jsonEqual`), so «the merge changed this record» and «this side changed it» never
  disagree about a re-sorted value. Every entry says which records its undo/redo TOUCH
  (`touches`): every record it writes, AND every record one of those values LINKS to — a
  placard's `dockedTo`, a Leitung end's attachment target, a `truppId`, a Gebäude body's
  `building:` (`objectRefs` / `annoRefs`, old value and new) — because re-stating a link means
  «where the target is NOW», and a ↷ that re-docks onto a host another device moved would land
  at the old spot. The merge drops each entry that touches a changed record, plus — walking in
  the order the steps would be taken — every entry behind a dropped one that touches a record
  the dropped one touched (its effect is now permanent). An entry with no `touches` is dropped
  by any real change, and so is everything older. An echo drops nothing. The delegating
  domains then keep exactly the steps whose entries survived (`step`), RE-LAID onto the merged
  state as a patch of the records each wrote (`rebaseHistory`; an open Karte drag via
  `rebasePending`) — the Karte store per object, the slices per record — so no snapshot carries
  a pre-merge value of a record the merge changed. A Plan's stack is whole-sheet VIEW snapshots
  (an absent anno is a deletion), so it cannot be re-laid: it survives only WHOLE
  (`planStackTouches` names the stack's every object, link and its view), cut by step id
  (`keepPlanSteps`). The confirm-with-undo toasts are guarded too: `undoToast(…, guard)`
  declines with «Nicht mehr rückgängig machbar» once a merge changed a record it would write or
  link to (or its entry is no longer `standing`); a toast whose target lives outside the
  workspace checks the target itself (`georefStillIs`). The whole
  bookkeeping runs through `carryUndoThroughMerge`: if any of it throws, the old rule applies
  (timeline cleared, every history dropped, the merged state still lands). ⚠️ ↶ never turns
  into an older act SILENTLY (staging r3, F8): when a merge drops the step ↶ would have taken
  back, the NEXT ↶ press says so at the button instead of stepping («Letzter Schritt nicht mehr
  rückgängig machbar – ein anderes Gerät hat … geändert», `onTopDropped` → `IncidentWorkspace ·
  pressHistory`; a toast per merge until 17.11.2026), the press after it steps; and the header's label and flash caption name the SURFACE
  in front of an action that does not already say it («Trupps · Trupp 1 (…): Ausrüstung: WBK»,
  `undoTimeline · undoCaption`, `copy.undoSurfaces`) — the Verlauf row keeps the bare action. Add an entry ⇒ give
  it a `touches` that covers EVERYTHING its undo and redo write, and every record those values
  link to; add an id-valued link field ⇒ add it to `objectRefs`; add a synced slice ⇒ its
  `WORKSPACE_RECORDS` row (tsc asks) AND its entry in `liveWs` (tsc asks too, `RecordedField`).
  A Trupp's grow-only `crewFiled` marker is not part of its record here, because every Trupp
  inverse keeps the live one (`keepCrewFiled`).
