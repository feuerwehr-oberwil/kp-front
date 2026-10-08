# Phone layout

How the app fits a phone: the two bottom bars, the page heads and the pages. Module rules live in
`lib/toolFold`, `lib/whiteboard · containFit`, `lib/useHoldEntry`, `lib/pageHeadFit`,
`lib/shifts`, `lib/journalFilter`, `lib/useModifierHeld`, `components/GroupChooser`,
`components/ZeitplanView` and `lib/abschluss`. Moved here from AGENTS.md on 2026-10-08, wording
unchanged.

## The two bottom bars

- **The phone's two bottom bars hold what 360px holds without scrolling** (18.09.2026) — five wide tiles at most, never a scrolling lane whose only cue is a fade.

- *Every tile of a bar is ONE equal share* (03.10.2026, owner: «auswahl and messen is way
  bigger than ansichten»). On a folded phone bar the tool lane and the pinned footer step aside
  (`display: contents`, 15-mobile.css) so all tiles are items of the bar's own row, `flex: 1 1
  0`, on its one 2px gap — never a percentage per wrapper: the old 60/40 split assumed three
  tools, and the read-only set (Auswahl · Messen) stretched two tiles over 60%. A word longer
  than its share ends in «…» inside its tile. The compass needle turns with the finger
  (`lib/liveBearing`, like the wind arrow), not on release.
- *The compass lives in the BAR, beside Ebenen* (05.08.2026). It floated top-right on the map
  for one day (18.09.) and came back: up there its menu opened half a screen from the thumb that
  asked for it. «Mein Standort» is a row of that menu, not a tile of its own (also tried 18.09.).
- *Words under the glyphs by default on a phone* (29.09.2026, owner: «at least on mobile
  default to "Wörter" so that all toolbars and views are always labelled»). The Einstellungen
  «Beschriftung der Werkzeugleisten» (`lib/prefs · railLabels`) reads ON on a phone
  (`railLabelsFor`, `PHONE_QUERY` at boot) and OFF on a tablet (the words widen the rails into
  the map). It covers the nav bar (Karte · Pläne · Checkliste · Trupps · Einsatz) and the tool
  bar of the Karte and of every Plan; the tool DOCKS (a tool's options) are not rails and stay
  icon + ⓘ. A hand choice is marked (`railLabelsChosen`) and always wins; a stored 'off' without
  the mark is the old default the app saved for everybody, not a choice.
- *«Einpassen» on a Plan is the bar's tile*; the top bar's twin (`TopBar · mapNav`) survives only
  where there is no bar at all (viewer-only Modul, Gebäude pick surface, replay — 20.09.2026).

- Every BAR stacked above the nav bar keeps ONE 6px channel (`--rail-h + 14px`: the tool bar,
  `.rp-tabs`, the page card in `Surface.module.css`); the floating row above the bars keeps the
  family's `--float-gap` (8px) — the gap its pieces keep from each other and from the edge.
- Tried and thrown out the same day, so nobody rebuilds them: a «Zeichnen» tile with a flyout, the
  same tile opening the GroupChooser behind a last-used first tap, and a «Karte» tile folding
  Ansichten + Ebenen. The vertical rails (tablet/desktop) are unchanged throughout.

## Page heads and pages

- *A docked tab strip is RESERVED by a sum of tokens, never a number* (30.09.2026, owner: «the
  journal entry slightly overlaps with the selector below»): `--rp-tabs-safe` (15-mobile) is the
  strip's height — `--tap` + the `.useg` track's 3px + `--bar-pad` + 1px edge, top and bottom —
  plus its 6px channel. A literal 60px outlived a 4px shell padding and stood the FAB, the
  message lane, «Zurück zum Rapport» and the page's foot 10px low.
- *ONE page-title size*: `--head-title` is 17px on a phone, set as the TOKEN in `15-mobile.css`
  — never a per-surface `font-size` on the `<h2>`, which is how «Einsatzrapport» came to stand
  19px beside «Anwesenheit» at 17. The Rapport's head carries the title and what is still open;
  the «n Personen · m Positionen» line under it is gone (19.09.2026).

- *A head's quiet line is said WHOLE or not at all* (30.09.2026): free text there (the
  Checkliste's subtitle) wears `data-fit-check` and the ladder's FIRST rank, so it folds away
  whole before the tiles give up words — never «Aktions-Checkliste Fü…». On a phone the
  Checkliste runner shows no head row at all: the chooser row names the list and carries its
  «n/m» at the right. **No progress bar anywhere in an open checklist** (05.10.2026, owner: «the
  checklists don't need a progress indicator. Occupies too much space») — the count is the
  progress: «n/m erledigt» in the tablet head, «n/m» in the narrow chooser row and on each phase
  head; no bar, no percentage. The chooser row leads with the list's rail glyph, never a 🔍.
- *No card inside the page card* (30.09.2026, owner: «in the rapport we have double stacked
  cards on mobile»). A surface's sections sit ON the page card: no frame, no fill, the content
  at the head's inset, a `--glass-edge` hairline over each section with its eyebrow (or its
  round-up row's title) as the head, and no hairline over the first one under the head's edge.
  The Rapport does this wherever it is ONE column (< 1080px — phone and portrait tablet; on a
  phone per tab, `13-incident.css`), the Checkliste on a phone; the Rapport's two-column layout
  (1080+) keeps its cards, which face each other across the page. Rows in a list (Material,
  Anwesenheit, checklist items) are not sections and stay rows.
- *Mobile space and positioning* (01.10.2026): the Zeitplan's empty-grid ⓘ shares its clock
  header instead of reserving a footer row, using the header's surface and control edge.
  The Rapport's «noch offen» popup hugs its content, with only its maximum height bounded to
  one gap above Eintrag. «Anderes Objekt» has a bounded scrolling list above its map (36dvh,
  capped at 300px) and shows
  the device's position; while typing, the map yields its space to the results. The opened
  Trupp is parked again when «Im Einsatz» moves it to another section, by scrolling its own
  port. The mobile Einsatz form answers «Übung?» with «Nein | Ja»; wider forms keep «Aus | An».

- *A monogram chip keeps its HEIGHT; the text steps down and the box hugs what is left*
  (`data-mono-len` on the chip; the rail's tiles and the `GroupChooser` rows each restate the
  steps) — the same chip on a phone as on a wide screen. A fixed square was tried and cannot
  work: «RWA» in Sora 800 is 25.5px at 10px, against a 27px inner box (19.09.2026). The
  chooser's glyph column is 44px, the widest chip, so every row's name starts on one line —
  and the EXPANDED rail's column does the same (22.09.2026): the rail stamps its longest
  monogram on itself (`data-mono-max`) and the column is 26 · 28 · 38px for a digit · «PV» ·
  «RWA», one width for every row, so no label steps out of line and no chip is clipped.

- *A head's icon buttons carry their word wherever it fits* (22.09.2026): «Reihenfolge ·
  Überwachung abgeben · Alarmton» on the Trupps head — MEASURED since 28.09.2026 (the page head's
  ladder, `lib/pageHeadFit`; the `.wordBtn`/`useIsPhone` switch there is gone), so a phone that has room shows
  them and a tablet that has none folds them. The search line's «In Verwendung · Filtern ·
  Anderes Material» (`SurfaceControls.module.css · .wordBtn`) is not a page head and keeps its
  `useIsPhone` switch. A bare square's way of asking is the hold-tooltip. The bell's word is its
  honest STATE (Alarmton / Stumm / Ton freigeben).
- *A checklist item that writes to the Verlauf says so on its row* («⚑ wird im Verlauf
  notiert», `checklists.milestoneTag`, 22.09.2026) — the lone flag's meaning lived in a tooltip
  no tablet shows.
