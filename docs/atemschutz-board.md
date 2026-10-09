# The Atemschutz board

The Trupps page: the phone board, the one card every board wears, the Trupp form and its
questions, and what the record keeps (`components/AtemschutzView`). Module rules live in
`lib/truppLeader`, `lib/contactEcho`, `components/TruppSheets`,
`components/AtemschutzAlarmMeldung` and `lib/meldeleisteHost`. Moved here from AGENTS.md on
2026-10-08, wording unchanged.

## The board

- **The Atemschutz phone board of the full app** (`AtemschutzView · phoneMode` = phone and not the
  handed-over Tafel; PR #212 and its follow-up, 24./25.09.2026, Übung 23.09.): sections Drin ·
  Sicherungstrupp · Bereit · Draussen, «Drin» by urgency with the 2 s freeze, «Druck | Kontakt»
  with words, one `PressureSheet`. The tablet grid and the Tafel are NOT this board, except where
  a rule below says «every board» — their CARD is (see «The opened card …»). The rules:
  - *The opened card is the row grown downwards* (owner, staging 26.09.2026): the same frame and
    tone, the same line (`RowLine`: dot · name · clock) and the same «Druck 240 bar | Kontakt» pair
    (`TruppPair`) in the same place, collapsed or open, in every tier — opening only ADDS the
    Kennzeile (the tier in words where there is one; the ⋯ at its end), the note,
    Rückzug / Raus, the Sockel line and the Verlauf. No band, no second Kontakt, no Druck row. The
    whole first line is the collapse toggle. ONE card on every board since 29.09.2026 (owner:
    «assimilate the tablet / desktop view closer / equal to the mobile view»): the tablet grid, the
    desktop and the handed-over Tafel (grid and phone focus) wear this same card — line · 2×2
    tiles · state words · note · fact chips · one terse foot that ENDS with the ⋯ (29.09.2026, owner
    pick B — as the facts' last chip it wrapped onto a 44px row of its own). What differs is only
    what the board has room for: on the grid every card stands open (the line is not a toggle, no
    chevron), the hand-set order keeps its ‹ › in the ⋯, and a card on a board without state heads
    (grid, Tafel — `headed` false) says «Bereit» in its state line, which on the phone is the
    section head. The state line never says what the card's colour already says (29.09.2026,
    owner: «drop the überfällig – if the card is red it's pretty obvious»; «the draussen subtitle
    is probably not even required»): fällig / überfällig live on for a screen reader only
    (`.sr-only`), and an out Trupp's card carries no «Draussen» — it keeps the words colour cannot
    carry (the Alarmdruck with its limit, the stopped clock, «Nicht eingesetzt», «Bereit», a work
    squad's state). The Druck is the pressure tile → `PressureSheet` everywhere; the
    tablet's ± stepper with «Bestätigen», the band with the 40px clock, the tablet's grey
    Kennzeile with its blue Auftrag, the top status edge and the «Verlauf · zuletzt: … Druck 300
    bar» preview are gone — do not bring any of them back for the tablet. The focus Tafel's one
    card shows the line's clock at 34px.
  - *The Schätzung stays readable on the card's foot* (29.09.2026, owner: «we still need the
    schätzung clearly visible»): the terse foot keeps its word and full ink — «1 d 11 h ·
    Schätzung ≈ 0 bar ⌄» — and the word, not a dimmed grey, is what keeps it from being read as a
    logged Druck. Its alarm case is the note under the tiles in the ONE form-warning look (ink
    13/700, ⚠ in `--red-strong`, 10% red tint, no border), never red text in a red box.
  - *Rückzug and Raus are equal tiles on every board* (29.09.2026): both framed grey, «Rückzug»
    amber only at or under the Trupp's Alarmdruck (`.actAlarm`). A permanently amber «Rückzug
    melden» says «warning» about a Trupp at 300 bar.
  - *A Trupps section head* (Drin · Sicherungstrupp · Bereit · Draussen, and the grid's
    Atemschutz / Weitere Trupps) is the eyebrow and the count badge — no hairline rule to the
    edge (29.09.2026); the boundary is the air above the head — ONE number, 26px (`.sectSecond`),
    and on the phone board ONE adjacency rule gives it to every section after the first, the
    Sicherungstrupp zone included (`.phoneBoard > * + :is(.sect, .safetyZone)`, 30.09.2026:
    Sicherungstrupp and Draussen sat flush on the card above). A head keeps 12px to its first
    card. Never give a section its own top/bottom margins.

- *The handed-over Tafel's strip (focus mode)*: the chosen Trupp tab is the nav's ink pill
  (`--ink-fill` / `--on-accent-ink`, 29.09.2026), never an outline ring; on a red or amber tab
  the fill wins (the card shows the tier). The add cell reads «+ Trupp» — a full cell has room
  for the word.

## The Trupp form and its questions

- *A door answers the same question the same way* (29.09.2026): the Trupp form and the Auftrag
  sheet share their Ziel and Leitung controls — `ZielChips` under the Ziel field for EVERY
  Auftrag, and `TruppSheets · LeitungField` («keine · Ltg n · Nr. …»). Ziel chips are
  SHORTCUTS: a pick fills the field and the chip is never drawn as chosen (no `aria-pressed`, no
  `--sel`); the field holds the answer.
- *The form asks Druck and Kanal in the sheets that ask them on the card* (30.09.2026, owner):
  one row each in every mode, «Eingangsdruck 300 bar ›» / «Funkkanal 11 ›», opening the Druck
  sheet (20-bar grid, the form's value filled — `PressureSheet · chosen`) or the Kanal sheet
  (`KanalPickSheet`, pad, or the ± stepper with tap-to-type and «Übernehmen» for a range too
  wide for keys). A tap fills the draft and closes; nothing is written until the form's save.
  The sheets are NESTED in the form's popup (their host stops pointerdown so the form's swipe
  does not move with them); Escape closes the sheet, never the form. The grid and the pad never
  sit inline in the form, and the «Standard: … — Ändern» fold is gone. The low-Eingangsdruck
  «Ändern» opens the Druck sheet; the lock after the Austritt and «Gleiche / Neue Flasche» are
  unchanged. The form's ± steppers are gone — do not bring them back.
- *The Trupp form is a bottom sheet there, with the due clocks above it* (D1 ⑥): at most two
  due/overdue Trupps, most urgent first, each with a live «Kontakt» that confirms without
  leaving the form. The pinned set holds 2 s after a tap and the row just confirmed reads
  «✓ Bestätigt», disabled — it stays under the finger. The rows sit INSIDE the popup (under the
  scrim they would be outside presses). Grab bar + swipe-to-close, which is «not now».
- *A kept draft belongs to ONE state of the Trupp* (`draftKeep`, every width): only «Abbrechen»
  and a save the board CONFIRMED drop it (a «Zurück» on any question in front of the save
  returns to a filled form), but an edit / re-entry draft is keyed on the Trupp as the form
  opened it (sortie + every field the form writes, `truppDraftStamp`) — a new sortie, or a
  Leitung linked on the Karte meanwhile, opens a fresh form. «Gleiche / Neue Flasche» is never
  kept. A door that answers a field (`presetAuftrag`: «Bestimmen» → «Sichern») beats a draft.
- *An edit is a PATCH* (every width, 25.09.2026): only the field groups the form touched
  (`truppFieldGroupsChanged` against the form's own untouched values) are written, onto the
  Trupp as it stands NOW (`truppEditPatch`); a touched group another device changed since the
  form opened is said in one line first, «Zurück zum Formular» focused. A Gast typed into the
  form reaches the Anwesenheit only at the save (`fileGuests`, after every question) — never
  from the picker, and Enter in «Person suchen» only takes a listed person.

## The Sicherungstrupp, the Abschluss and the record

- *The Sicherungstrupp has ONE place* (D1 ⑦): between Drin and the rest while anybody is in or
  waiting — a quiet dashed slot while nobody is inside, amber from the first crew in, gone once
  every Trupp is out. «Bestimmen» = a waiting Trupp's Auftrag becomes «Sichern» (an ordinary
  edit) or a new one registered on «Sichern». Its first Eintritt writes «Sicherungstrupp
  eingesetzt». The Abschluss (every width) asks about every Atemschutz-Trupp still angemeldet
  that was never inside (a Reserve after earlier sorties was — read the log, `entryTime` is
  cleared on a re-park): «Zur Tafel» (focused) / «Als «nicht eingesetzt» schliessen». Not while
  a crew is still inside, and the stand-down runs only after the FINAL «Abschliessen», re-checked
  against the Trupps as they stand then — a crew sent in meanwhile never gets an Austritt.
  Crews still INSIDE are the Abschluss's own FIRST question, by name («2 Trupps sind noch drin:
  Trupp 1 (…), Trupp 2 (…).»), «Zur Tafel» focused, closing anyway the quiet answer — and after
  the Abschluss the app lands on the LAUNCHER (App · completeRapport, 05.10.2026), never opens
  another: the closed Einsatz is forgotten on the device and `prefs.landedAt` keeps a cold start
  on the launcher too, until one is opened by hand or a NEWER alarm arrives (pickBootIncident).
  A Sicherungstrupp wears «SiTr» on its row and card at every width, sent in or not.
- *The record is kept whole* (staging walk-through r2, 25.09.2026): the Gäste the form files at
  its save are filed QUIETLY and named once in the crew's «Unter AS: …» row — the crew filing
  knows them (`IncidentWorkspace · fileTruppGuest`) instead of reading a render-old Anwesenheit
  and filing them again. A session that cannot write the record (the Atemschutz-Link) files and
  logs nothing; every device that can OBSERVES the Trupps and files a missing crew under derived
  ids (`lib/crewFiling`) — ONCE per (Trupp, person): the Trupp's `crewFiled` marker (grow-only,
  merged as a union, kept by every undo restore) records who was filed or already there, so a
  person somebody takes OFF the Anwesenheit is never written back by another device (the
  ghost-trail trap). «Entfernen» on a crew INSIDE asks first («Raus melden» focused), and
  every removal raises the confirm-with-undo toast. «Nicht eingesetzt» is a VISIBLE quiet button
  on its own row — never beside «Im Einsatz», not hidden in the ⋮ (owner review 26.09.2026) —
  answered by a confirm-with-undo toast, and its log row reads «Nicht eingesetzt», never
  «Austritt». A question dialog of the Tafel has a TITLE that states the fact, at most one short
  body line, and the verbs on its buttons (recognition over reading, same review).
  No «#N» on the row or the card (30.09.2026, owner: «the group leader name needs more space …
  drop the number #»): the leader's name is the label, a step larger (17.5px, 16.5 ≤ 760px) with
  12px to the clock; the number stays in the TruppFinder and the Verlauf. The handed-over phone board opens on the most
  urgent crew inside; the Eintrag FAB is not drawn over the phone Trupps page (a floating button
  over a scrolling list of Kontakt buttons cannot be kept clear by an inset).

- *The Eingangsdruck is guarded, once* (item 2, every width): locked in «Bearbeiten» once the
  Trupp is raus (pointing at the exit's Restdruck); below `doctrine.entryPressureMin` (default
  270, `/admin › Doktrin`) the form asks ONE question with the value on the button and «Ändern»
  focused. No upper bound, no second plausibility rule.
A question whose «yes» WRITES something a reflex must not (these three) puts the safe answer
first: `ConfirmSpec · safeAnswer` ('cancel' | 'alt') fills and focuses it, not red. Every
question MOUNTS FRESH (`Overlays` keys the card per request, staging r3 F5): a chain answered
and re-asked in one render batch kept the node, and the focus of the «Trotzdem abschliessen»
just tapped stood on the next question's same button — Enter closed through «vermisst».
- *One act, one ↶* (staging r3 F1): a Trupp save — create, edit, re-entry — is ONE timeline
  step with the Gäste it files and the Funktion it writes (`undoTimeline · group`,
  `IncidentWorkspace · openTruppSave`, the save's Anwesenheit writes folded into one slice
  step). ↶ reads «Trupp N … angemeldet» and takes the Trupp and its filing back together.
- *Closing over a crew inside is said* (staging r3 F4): the final «Trotzdem abschliessen»
  writes «Trupp N (…) beim Abschluss noch drin» per crew and no Austritt; the Rapport ends
  that sortie at the close with the same words while the Einsatz is closed.
