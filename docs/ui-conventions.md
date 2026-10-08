# UI conventions

The look and the controls, app-wide: editor sheets, overlays, the button spec and the touch
vocabulary. The tokens, the one corner and the style-debt ratchet are summarised in
[`AGENTS.md`](../AGENTS.md); phone-only layout is in [`phone-layout.md`](phone-layout.md). Moved
here from AGENTS.md on 2026-10-08, wording unchanged.

## Editor sheets: one control per kind of question

- **The editor sheets have one control per kind of question** (decided 01.09., same sweep). A
  yes/no property is the `OnOff` Segmented pair (`components/Segmented`) – never a single chip
  whose text or glyph flips, which said «An» on one row and showed a state on the next.
  That holds app-wide, not only in the editor sheets (28.09.2026): the Einstellungen, the Übung
  on the Einsatz form and the Kroki's «Folgt der Karte» are `OnOff` rows too, always «Aus | An»
  in that order (a row's own «Ein | Aus» with «on» on the left reversed the thumb position). A
  **«none of these»** answer that stands in for a list (Material «Nichts verwendet») is a
  CHOICE chip: one fixed text, picked = the choice fill, and no «✓» growing into the label. A
  single option on a sheet is a yes/no too (PersonnelSync «… ausblenden» is an `OnOff` row, not
  a native checkbox). Only a control that picks ITEMS in a list is multi-select. The
  head-bar status buttons (bell, share QR, the menu's Standort row) name the state that is TRUE
  now and are not yes/no properties.
  A number
  is the shared `Stepper`; where the two surfaces cannot agree on a unit (a Form's size is metres
  on the Karte and a share of the sheet on a Plan) it is `ScaleStepper`, the same chrome handing
  the caller a ×-factor. A one-press action is a `.de-action` row, in the grammar «Verbindung
  lösen» already had – it is not given toggle chrome, because it has no state to be in. Rows are
  grouped in `.de-group`, and since 18.09.2026 a group boundary is SPACING: a hairline is drawn
  ONLY above a group that opens a NAMED section («Messung», «Verbindungen» — matched on the
  `.de-group-toggle`/`.de-conn-title` it starts with), because four or five rules stacked down a
  340px panel read as a bordered table and said nothing the padding did not. «Spacing» is the
  ROW RHYTHM, not a band of air (20.09.2026): plain groups follow each other as one continuous
  list of options — the 24px the dropped rules left behind read as something missing. The same
  rule reached the app chrome on 22.09.2026, and was then tuned by hand the same day — what
  stands is: the TOP BAR has ONE 8px gap between every neighbour and no groups at all (a wider
  «group gap» was tried and read as holes); the LEFT rail keeps 14px of air around the plan
  tiles; the TOOL rail's tools are ONE undivided list (the `sep` entries left `mapTools` /
  `planTools`) and its one hairline is the FOOT's, above the generic controls (Ebenen · compass ·
  zoom) — a real seam, where «select vs. create» was noise; the map-utility cluster has air; and
  the Einsatz menu draws ONE hairline, above the identity row (the small-caps label heads «App»
  on its own, but the signed-in row is not an action and the rule says «the list ends here»).
  The Trupps section heads draw no rule either (29.09.2026 — see the Atemschutz board).

A hairline also survives where it carries a label (`.jr-day-sep`) or guards a destructive row
in a `Menu`.
And **no native form
control** on these surfaces: the app's own `Menu` instead of a `<select>`, the `Stepper`
instead of a number field, `components/Slider` instead of `<input type="range">`.
**One question, one name, one place, in every sheet that asks it** (29.09.2026): the Einsatz
wizard and «Einsatzdaten bearbeiten» share the «Alarmierung» section – eyebrow, then
«Alarmzeit», then «Alarmmeldung» (the Rapport's word). A one-step sheet's footer cancel is
«Abbrechen»; «Zurück» only where there is a real previous step. The composer's Art is ONE of
three with «Info» preselected – «nothing» and «Info» were two ways to say one thing; «Info»
still writes no `entryType` and no marker. An optional count with a «Keine» answer beside it
shows «–» while unanswered, never «0». Its ✕ stays visible and disabled while empty, so filling
or clearing the count never shifts the adjacent controls.
**A sheet whose edits are live has no confirm footer** (29.09.2026, owner: «everything should be
auto-saved without manual confirmations»): ✕ and swipe close it, and one quiet «Alles wird
laufend gespeichert.» line (`copy.savedLive`) says so (TimeBlockSheet, PersonnelSync result).
«Speichern» stays only where something is CREATED (Trupp anmelden, Einsatz eröffnen, Eintrag /
Mittel erfassen) or where a typed value would otherwise write a record per keystroke — the Trupp's
Auftrag sheet, the Schichtband edit and the Mittel pencil KEEP their Speichern / Abbrechen (owner,
29.09.2026: save-on-close was built and taken back; do not re-introduce it without asking).

**A symbol's context sheet is headed by its TYPE**, for every symbol, the generic Fahrzeug too
(«Fahrzeug» / the pack's name; 29.09.2026). A user-given name lives in its field
(«Bezeichnung») only — never twice, never an underlined head that jumps to a field. The foot's
«Erledigt» wears the same ink as «Zentrieren» (a dimmed action reads «not available»).

## Button components

- **New buttons are `<Button>` / `<IconButton>` / `<Chip>`** (07.10.2026, UI sweep C4;
  `components/Button.tsx`, `components/Chip.tsx`). `Button` variant `primary | secondary
  (default) | quiet | danger | go` (go = the green primary whose move keeps things as they are, the
  Meldeleiste's «Am Einsatzort lassen»), size `md` (44) `| lg` (52, the one big action of a screen),
  `block`, `icon`; `IconButton` requires `label` (aria-label + title, which the hold-tooltip
  reads), variant `quiet | secondary`; `Chip` is a choice (`selected` → `--sel` + aria-pressed).
  All default to `type="button"`. A surface's `className` on them is for placement only; a new
  look is a new variant there, not a local override. Do not write a new `.foo-btn` rule.
  `<Button>` and `.ip-btn` are ONE definition (08.10.2026): the component renders the global
  `.ip-btn` family (`primary` · `danger` · `quiet` (old name `ghost`) · `lg` · `block`; 13-incident ·
  «THE button»), 44px on every pointer and 52 for `lg`, so a hand-written `.ip-btn` and a
  `<Button>` cannot drift apart and 20-touch-floors needs no entry for either. The sheet ✕ stays
  `.ip-x` (36px, grey, 44 pad; owner spec below), not an `IconButton`.

## Overlays

Three rules the primitives own, so no surface re-answers them (18.09.2026):

- **What a surface IS on a phone — one rule, three shapes** (29.09.2026, owner: «rethink what is
  a modal and what a slide-up thing on mobile … ebenen, search, etc. should be a slide-up»).
  Pick by what the person DOES there, never by what was easiest to build: (1) a **tool or a
  list you work in while you look at the map / board / page** — Ebenen, the «+»
  chooser, a symbol's editor (`.ctx`), the composer, the Verlauf, the map picker, the plan's
  Passung, every form and settings sheet — is a **slide-up bottom sheet**: flush with the bottom edge and both sides, over the bars,
  the ONE grab bar on top, pushed down to close (`useSwipeDismiss`; the head is the handle),
  lifted by the keyboard (`keyboardLift`), the bottom inset paid by its last row. It HUGS its
  content up to a cap that leaves the top of the map in sight, so it grows upward and its foot
  never moves under the thumb. Detents only where the surface has two useful heights (the
  `.ctx` editors' half ⇄ full). Modal (scrim, focus trap) when it asks for input that must be
  finished or abandoned; NON-modal (a clear `.mapctl-backdrop`, no trap) when it only changes
  what the map shows — Ebenen is non-modal on purpose. (2) A **decision
  that blocks** — a confirm, «Welcher Trupp?», a one-field ask — is a **centred dialog**
  (`ConfirmCard`, `Overlay` without `grab`): it is answered, not worked in. (3) A **short
  pick-one menu that belongs to its tile or chip** — Ansichten at the compass, the Einsatz-Menü,
  the Meteo chip, every `Menu` — is a **popover anchored to that control**. Two exceptions,
  each a rule: a page you READ (Hilfe) is full-screen, and a search that opens with the keyboard
  (TruppFinder) hangs from the TOP edge so the keys never cover its results. A floating card
  above the bars (Ebenen was one until 29.09.) is none of the three: it cannot
  be pushed away and does not belong to its tile.

- **A sheet's footer row is `SheetFoot`** (`.ui-sheet-foot`, 26.09.2026): `Sheet` draws it for
  `footer`, and a bespoke frame whose footer is its bottom edge on a phone wears it (the Trupp
  form, the Mittel note, the Georef transfer). ONE rule in 15-mobile.css insets it on a phone —
  `max(20px, safe-area-inset-left/right)` and `16px + safe-area-inset-bottom` — at a weight a
  surface's own footer class cannot undercut; never inset a sheet footer per surface (the Trupp
  form's own rule lost to a later one and put its buttons into an iPhone's corners).
- **One menu row, one wash.** Every row `Menu`/`ContextMenu` renders wears `ui-menu-item`
  (+ `ui-menu-danger`), which carries the hover (`--blue` at 8 %, gated on `hover: hover`), the
  keyboard `[data-highlighted]`, the `--press` wash and the `--r-ctl` row radius
  (13-incident.css · «ONE menu row»). A caller's `itemClassName` skin owns padding, type and
  icons — never what a press looks like. Hand-rolled option lists (`.combo-opt`, `.pickOpt`,
  `.pp-row`, `.tb-uhr-row`, `.ip-ac-row`, `.lrow`) match those values.

## Buttons follow one spec

- **Buttons follow one spec – don't invent a per-surface variant.** Decided 2026-07-28 after a
  sweep found 12 label type combos, 6 disabled opacities and 8 stray radii for one role.
  - *The ✕ that closes a sheet is 36px with an 18px glyph, everywhere* (`.ip-x`, `.journal-x`,
    `.ctx-x` — one rule in 13-incident.css; it was 28/30/32). Beside a 44px search field it is
    44px instead (Palette, Verlauf search), and it is the ordinary grey, never a filled «on».
  - *Radius – ONE corner (25.09.2026):* **every** rectangle is `var(--r-sm)` (12px) – button,
    field, status box, row, card, page card, sheet, dialog, message; `--r-ctl`/`--r-surface`/
    `--r-hero` are aliases of it, kept only as role names. Three exceptions, each a rule, never
    taste: (1) things under ~32px tall wear `--r-xs` (the same shape at that size) and map
    furniture, dots, avatars and the FAB stay round – roundness is what tells map furniture
    apart from chrome; (2) a **floating container that hugs controls** (top bar, nav/tool bar,
    glass clusters, menus, docks) keeps ONE even gap all round – `--bar-pad` plus its
    1px border – and its corner is the controls' corner plus that gap, `--r-bar` (19px), so the
    curves run parallel like nested squares (the top bar had 7px above the pill and 11px beside
    it, and no radius could match both); a MESSAGE is not a bar – it wears the one corner itself
    and its buttons sit `--msg-pad` inside with `--r-msg-in`; (3) the **parts of one control** (segments in `.useg`,
    the zoom buttons in their group) are the control's corner less their inset. No literal px
    radius above `--r-xs` (hairline ticks and handles aside); the old 10 · 14 · 16 · 20 · 22 scale put three corners on three neighbouring
    buttons and read as a mess.
  - *Messages – ONE surface, ONE lane (25.09.2026):* a toast, a mode's instruction (Gebäude
    wählen), a tool's tip and the hold-tip wear the same look (08-toasts.css · «ONE message
    surface»): the floating family's material (below — light by day, dark by night, never a dark
    pill on a light UI), ink 14/500 (13/600 until 08.10.2026), the one corner, no outline of its own. A tone is the colour of
    the glyph the sentence leads with – never an edge, never a fill. What goes away **by itself**
    shows a ✕ and a line that runs out with its time (lib/ui · ToastRow); what stays while its
    mode is on shows neither. A tap on the pill itself does nothing (05.10.2026): the ✕ closes,
    the action button acts, a sideways swipe throws it away. On a phone they share one lane (`--msg-lane-bottom`, 15-mobile): the
    bars' own width (8px in from each side), one `--float-gap` above THE floating row (below),
    never beside a piece of it. A pill is ONE ROW (30.09.2026): the sentence wraps first, inside
    its column, and «Rückgängig» + ✕ stay beside it. The column has a floor of 10em (05.10.2026):
    only an action too wide to leave the sentence that much wraps under it, right-aligned. On
    the launcher the lane is the card's own column. There is no standing «Offline» row
    (removed 05.10.2026 — the head's «● Offline» chip says it), and «Jetzt synchronisieren» is
    never offered while the device is offline. While a MODAL bottom sheet is open the lane stands ON the sheet, one `--float-gap` above
    its top edge (`lib/toastLane` · `useToastLane` → `.toaster[data-lane]`); only a sheet that
    leaves no room for a pill above it sends the lane to the top of the screen, never over the
    sheet's head. Non-modal owners of the foot (detail sheet, Ebenen, Messen, Passung) keep the
    lane under the top bar. No Meldeleiste row has a left edge (29.09.2026: the alarm's red
    bar first, then amber / blue / grey): a row's tone is its leading glyph's colour, so every
    `Meldung` carries an `icon`. A row TITLE whose way in is the same
    move as the row's filled button (the Atemschutz «Zum Trupp» — `Meldung.onOpen.label` = the
    primary action's label) stays tappable but draws NO underline (`.ml-open.plain`, derived in
    `Meldeleiste · MeldungTitle`); the underline is only the signal where the title is the ONLY
    door. A button never repeats the glyph its row already leads with.
  - *ONE floating family, ONE floating row (26.09.2026, owner: «everything has the same shape,
    colour, padding»):* every small thing that floats over the Karte or a Plan — the messages
    above, the plan's chips (Objekt · Gebäude · Massstab · ⌖ Karte),
    «Zurück zum Rapport» and the Eintrag FAB — wears `--float-*` (01-tokens): the bars' glass with
    their `--glass-line` edge as an INSET ring and `--shadow`; ONE row height `--float-h` (a --tap
    button + `--msg-pad` all round = 52px); the one corner; 14px before the glyph; 16px glyphs. A
    STATE is a glyph colour inside it — the chip's lamp, a toast's leading icon, the object chip's
    amber ⚠ — never an outline (the Massstab chip wore a blue ring beside its green lamp); «open /
    armed» is a blue wash mixed into the glass. «Not yet» is GREY (29.09.2026): a plan with no
    scale and no link shows a grey lamp, never red (red = danger, act now; an unlinked plan read
    as a picture is not an emergency). And ONE chip says it: until a sheet is linked, «Karte
    verknüpfen» (the link glyph, never the locate crosshair) is the pill row's only chip — a link
    gives the scale; «Massstab» appears once a link or a hand calibration exists (the hand
    calibration stays reachable through Messen · «Massstab kalibrieren»). Where a plan cannot be
    linked, the Massstab chip stays. On a phone the pieces stand on ONE baseline,
    `--float-bottom` (15-mobile): `--float-gap` (8px) above the highest bar (nav bar · Rapport tab
    strip · tool bar · a tool's option dock + its hint row), 8px from the screen's edge and from
    each other. The FAB stays ROUND (the one-corner exception) but is `--float-h` across, on that
    baseline; `--fab-safe` is its width + the gap. A new piece in that zone joins the family and
    the row (and the `--float-row` `:has` list) — never a height, material or offset of its own.
    The Meldeleiste hangs from the top and ENDS where the message lane starts (`--msg-lane-bottom`,
    08-toasts · phone `.ml`, 08.10.2026): one `--float-gap` above the floating row, or the highest
    bar when the row is empty. Past that it scrolls. It never runs under the FAB or a bar. Four
    rows put «Jetzt aktualisieren» under the FAB.
  - *Type:* two sizes, two weights. `12.5px/700` compact (toolbars, docks, dense rows, chips),
    `14px/700` standard (sheet footers, form + page actions), and `800` **only** on the single
    action of a surface (Kontakt, Speichern, Senden). Nothing else.
  - *Two materials, by what the thing IS (29.09.2026, owner):* everything that floats over the
    Karte or a Plan — the floating row, Ebenen, the Ansichten menu, the context
    panel, every sheet — wears the **floating family's material**: `--float-bg` + `--float-blur` +
    `--float-edge` (or the sheets' `--glass`), light by day and dark by night, with theme inks
    (`--ink`, `--ink-dim`, `--ink-faint`, `--fill-soft`) — never a frozen `rgba(255,255,255,…)`. Every popup
    OUT OF THE TOP BAR wears the bar's own glass (`--glass` + blur + `--glass-line` + `--shadow`):
    the Einsatzuhr menu, the Atemschutz head detail and the Meteo details (30.09.2026:
    `.tb-weather-pop` wore `--surface`, a lighter slate than the bar at night).
    **On tablet/desktop, dark in both themes (`--ink-fill` + `--on-accent-ink`) is the ARMED material and nothing
    else**: a tool dock (`.wb-dock` — something is armed, its ✕ disarms) and the Trupp marker's
    action bar (`.wb-pill-acts` — this marker is in hand). It is the «clean selected state» of a
    mode, so a list you read or a menu you pick from never wears it; a new surface that is dark
    by day is a mode, or it is a bug. On a light-by-day card the ✕ is the global `.ip-x` and the
    primary is `--btn-primary`; the on-ink ✕ (`.wb-dock-x`) and the light-fill primary
    (`.wb-dock-go`) belong to the armed material only.
    **Mobile tool docks use the popup material** (01.10.2026): Messen and every tool-option
    dock wear `--float-bg` / `--float-blur` / `--float-edge` and theme ink, including their controls.
    Their controls share a neutral fill and selected wash, with a centred row; the line dock
    has no subtitle on mobile (its instructions stay behind ⓘ).
    The sticky close button has no masking shadow: a solid surface patch mismatches the glass.
    The blank Tafel offers no Messen on a phone; map and scaled plans keep it. The mobile
    Ansichten popover dismisses on an outside pointer press, allowing the pressed control to act.
  - *Height is a separate axis* – `--tap` (44px) by default, 48–50px for a card's main action.
    The 12 type combos happened because people enlarged the *label* when they wanted a bigger
    *target*; raise the height, not the font.
  - *Colour:* the primary fill is `var(--btn-primary)` (+ `--btn-primary-hover` /
    `--on-btn-primary`), never `--ink-fill`/`--blue`/`--accent` directly. **Red never fills an
    action** – it means danger/delete only. Amber = warning but not critical; red = danger,
    broken, act now; blue/grey = normal status and in-progress.
  - *Disabled:* `opacity: var(--disabled)` + `cursor: default`. Never inline the number.
  - *Selected – three roles, one look each (28.09.2026, owner: «all buttons have different
    selected states» — the Trupp form alone wore four: ink outline, blue ring, ink fill, blue
    segment).* (1) A **choice** — a segment, a chip, an option tile, a toggle chip, single or
    multi — is `--sel` filled with `--on-sel` text and `--sel-shadow` (01-tokens), whether it
    sits in a Segmented track, stands as chips (the Segmented's ≥5 mode too) or is a module's
    own class. (2) A **row** in a list or menu (a combo option, a picker row, an option card
    with a radio mark) is picked by `--sel-wash`, never filled — a filled row is a slab. **Nothing
    else rides on the wash** (29.09.2026): no ring, no recoloured read-out; a count keeps its own
    ink (an open count is amber on every row, current or not — `.group-choose-count.open`); a ✓
    may stay as the cue that is not a colour. (3)
    **Where you are** — the nav rail, the armed tool, a Trupp tab — keeps the ink pill
    (`--ink-fill`): a place, not an answer. A chip whose tone IS its meaning (the composer's
    Auftrag/Sofort) fills in that tone, same shape; colour swatches keep
    their ring (their fill is the colour). Never an outline-only «selected», never `--ink` as a
    choice fill (at night it is the primary button's light grey).
  - *Primary (28.09.2026):* the single action of a surface is `--btn-primary` / `--on-btn-primary`,
    14px/800 — never `--blue` (blue is «chosen», `--sel`), never `--ink-fill` directly (at night it
    is a 1.14:1 patch on the sheet), never green. On the ARMED material (a tool dock, the Trupp
    marker bar — dark in both themes) the primary is the LIGHT fill: `--on-accent-ink` with
    `--ink-fill` ink (`.wb-dock-go`). The documented green «go» (`<Button variant="go">`, Atemschutz «Eintritt») is a
    tone, not the primary, and stays. The Trupp marker's action bar (`.wb-pill-acts`) is all
    neutral wash (29.09.2026): no green «Bei den Trupps zeigen», no blue «Position markieren». A
    door to a page wears that page's nav glyph («Bei den Trupps zeigen» = the Trupps stopwatch,
    never ⚠). The bin keeps THE delete outline; the rename pen, while its field is open, is a
    pressed toggle (`--sel`, like `.wb-dock-tog.on`).
  - *Delete (28.09.2026, owner pick A):* a destructive action is THE delete look — `--del-ink`
    (red-strong) text, a `--del-edge` (red 40%) border, the surface it stands on; the bin and the
    word (a rare delete may be a square bin, still outlined). Red never fills it (`.btn.warn`,
    `.ip-btn-danger`/`.ip-btn.danger`, `.adm-danger-btn`, `.wb-pa-del`,
    the audio player's marker row `.ap-row-del` all wear it; `.btn.warn-solid` is gone). ✕ only
    ever closes or clears — a ✕ that deletes is a bug. The audio player's in-place editors are the
    ✕ `.ip-x` + ✓ primary icon pair (36/44).
  - *Close:* every sheet/dialog ✕ IS the global `.ip-x` in the TSX (36px, 18px glyph, grey fill);
    a module class may position it, never restyle it. 44px only beside a 44px search field
    (Palette, Verlauf search, TruppFinder — `.x:global(.ip-x)`). The armed material keeps its
    on-ink ✕ (`.wb-dock-x`); Ebenen wears `.ip-x` (`.lc-x` only places it). A
    menu has no ✕ row and no lone ⓘ row (29.09.2026): its tile toggles it and a row or a press
    elsewhere closes it; an ⓘ sits at the END of the last row and opens its sentence under that
    row (Ansichten).
  - *Cancel (28.09.2026, owner pick A):* «Abbrechen» in a footer is a FRAMED `.ip-btn` 14/700 at
    its word's width, never a ghost word; the primary takes the rest of the row, same height (on a
    phone `[role=dialog] .ui-sheet-foot > .ip-btn.primary` flexes).
  - *A label never leaves its button* (30.09.2026, owner: «fix this» — «Auf Modul 1 zeigen» ran
    out of its tile over «Zentrieren»). A tile in a row whose share is fixed (`flex: 1 1 0`) cuts
    its label with an ellipsis; where the label carries a NAME (`{plan}`), the name is the part
    that gives way and the verb around it stays (ContextPanel · `LinkBtn`, `.btn-t` /
    `.btn-t-cut`), with the whole sentence as the button's name. A door to the object's other
    surface («Zum Original», «Auf {plan} zeigen») stands on a row of its own above the symbol
    panel's foot. A rotation reads in whole degrees; ± from a hand-turned angle snaps to the next
    15° mark (`Stepper · snap`).
  - *Text actions (28.09.2026, owner pick A):* no bare blue word as an action. A verb that ends a
    row makes the WHOLE row the button — `.row-go` (13-incident): ink text, the verb in
    `--ink-dim` 12.5/700 + a 16px `chevron`, one press wash, ≥44px, `aria-label` «Verb: row text».
    A fact that jumps inside a sentence is ink + › (`.kennGo`); anything else is a framed compact
    button (`.wb-nearby-switch`, `.de-conn-reveal`).
  - *Fields, titles, eyebrows, warnings — one look each (28.09.2026, owner: «remove what
    contradicts»).* (1) **Focus** on anything you type into is `--focus-edge` + `--focus-halo`
    (01-tokens), the `.ip-field` look: a half-blue edge and a soft 3px halo. It is never solid ink,
    solid blue, a blue wash or an underline. A borderless field draws the edge as an inset ring
    (`box-shadow: inset 0 0 0 1px var(--focus-edge), var(--focus-halo)`). Where a box wraps a bare
    input (a search pill), the BOX takes it (`:focus-within`) and the input wears nothing. (2) A
    **sheet or dialog title** is `--sheet-title` (800/17). The page head's `--head-title` (19) is
    for surfaces, so a sheet never out-shouts the page it opens over; a card head (Ebenen)
    is that sheet title without a leading glyph. A **field label** is
    `--field-label` (700/12) in `--ink-dim`, sentence case. (3) An **eyebrow**, the small
    uppercase label over a section or a menu group, is `font: var(--eyebrow); letter-spacing:
    var(--eyebrow-track); text-transform: uppercase` in `--ink-faint` (section heads such as
    `.lgroup`, `.sym-ghead`). When the colour carries a
    meaning (the amber Sicherungstrupp head, the red alarm kicker, a head that inherits its tone),
    it keeps that colour and only takes the type. Badges, state words in a row, brand wordmarks
    and the Kroki paper facsimile are not eyebrows. (4) A **warning inside a form** is THE global
    `.form-warn` (13-incident, 29.09.2026; lifted from the Trupp form): a rounded `--r-sm` box, ink
    text 13/700, the leading glyph in the tone over a 10% tint of it — `--warn-tone` red by
    default, `.form-warn-amber` when it does not block; `.form-warn-text` for the sentence,
    `.form-warn-act` for its one compact framed action in the tone (12.5/700, never 800, never
    filled), `.form-warn-compact` for the one-line note under a field. The Rapport
    Kontrolle/Zeiten, the QR-Bogen save error, Georef quality, Demo and the share sheet's note
    under the address (`.esh-warn`, amber) wear it; a module class only places it. It is never a
    full-width band, never red body text. A press on its sentence is the `--press` wash, never an
    opacity drop. A QR is framed once: its white tile is the frame, no box around it.
  - *Small roles – one look each (28.09.2026, owner: «remove contradicting UI»).*
    (1) **Add** is a framed «+ word» button: 1px `--glass-edge`, `--surface`, ink 14/700, `--tap`
    tall, the one corner — the `.cv-btn-add` look (13-incident). Dashed means «missing», never
    «add»; the ONE dashed add is «Foto hinzufügen» (`.cv-beilagen-add`, `.report-att-add`,
    decision D6 — it is the placeholder for a file). Icon-only where a column has no room (the
    Schichten ＋), still a framed --tap square. Floating over a plan it keeps the glass, not the
    shape (`.wb-floor-add`). Never a grey disc, a pill or a sub-44 tile.
    (2) **Count badge**: 16px tall, min-width 16, 11px/800, `--r-xs`, padding 0 4px. Fill is the
    meaning: ink (`--ink-fill` + `--on-accent-ink`) = a plain count, amber = open, red =
    missing/alarm — NEVER the station `--accent`, never blue, never a round pill (`.nav-count`
    in 05-navrail is the reference).
    (3) **Disabled** = `opacity: var(--disabled)` + `cursor: default` and nothing else — no
    repainted fill, no colour swap, no `not-allowed`, no inlined number (also not as a `var()`
    fallback). **Gone** (a person who left, a Trupp raus, a layer off) = `opacity:
    var(--done-opacity)` only; a strike-through may carry the word, a second dim may not. A
    read-only control that is NOT unavailable (`opacity: 1` on purpose) says so in a comment.
    (4) **Tag** (ÜBUNG, a status word): the `.ip-badge` recipe — 10px/700 uppercase .03em,
    padding 2px 7px, `--r-xs`; ÜBUNG is amber 16% + `--amber-strong` wherever it stands (top bar,
    lists, the poster's `.cv-badge-exercise` shares the selectors). Status words in a picker row
    («AS», «raus» in the TruppFinder) are this tag in ink on `--fill-soft` — never blue (blue is
    «chosen»), never a pill.
    (5) **Search field** (29.09.2026): every «type to narrow this list» is `components/SearchField`
    (`.ui-search`, 13-incident) — glyph · input · ✕ · optional count slot; the grey pill
    (`--fill-soft`) that turns white on focus with the one field focus on the BOX, `--tap` tall,
    the one corner, 16px text (iOS zooms into anything smaller). Its ✕ is a full `--tap` square
    at the pill's end, shown only while there is something to clear, labelled «Suche leeren». A
    surface PLACES it with its own class (flex, margin — `:where(.ui-search)` keeps the default at
    zero specificity) and may add a STATE (the Trupp form's `.teamSearchWant`); it never re-skins
    it. The one modifier is `variant="head"` (`.ui-search-head`): a card whose whole head IS the
    search (TruppFinder) — no pill, 18/700 query. ONE ✕ (29.09.2026, owner): where the search's
    own CLOSE ✕ stands beside the field and ends the search (the Verlauf's search row, the
    TruppFinder), the field drops its inner ✕ — `noClear`, a prop, never CSS hiding; Escape still
    closes. The Palette keeps both: its ✕ closes the whole «+» chooser, clearing only the query.
    Never a bare native `type=search`, never a framed white box, never a ruled band.
    (6) **ⓘ toggle**: `components/InfoToggle` (`.ui-info`) — the grey 36px chip with a 44px pad;
    OPEN is `--sel-wash` + `--blue-strong` glyph (the «open/armed» look). Never the choice fill,
    never the ink pill, never `--accent`. The dark tool docks keep DockInfo's on-ink ⓘ.
    (7) **No hits**: one line, `.no-hits` (13/500 `--ink-faint`, centred, 20px pad, never italic),
    worded `copy.noHits` «Keine Treffer für «{q}».»; a noun of its own only where it helps («Kein
    Trupp gefunden»).
    (8) **Fold**: every disclosure — a `<details>`, an accordion head, a notice that folds —
    carries the global `<Icon id="chevron-down" className="chev" />`, turned by `aria-expanded` /
    `details[open]` (02-base). Never an up/down icon swap, never a text ▸, never the UA marker
    alone.
    (9) **Filter on**: an active filter button is the choice fill (`--sel`) and nothing else — no
    dot beside it (Anwesenheit/Mittel `.iconBtnOn`, the Verlauf funnel `.jr-filter-on`).
    (10) **One glyph, one meaning, within a thumb's reach** (29.09.2026). «Eintrag» is the journal
    pen (`lib/icons` · `#entry`, drawn inline by `EntryGlyph` on the FAB and the top bar's
    Eintrag), never «+»: «+» means Hinzufügen only (the FAB stood 60px above the tool bar's «+
    Hinzufügen» with the same glyph, and the tablet's Eintrag sat beside the rail's «+ Symbol»).
    The top bar's Eintrag wears the FAB's material (`--float-bg` + `--float-edge`, ink), not a
    blue slab, and keeps its word «Eintrag» until the LAST step of the top bar's ladder
    (`HEAD_FIT_STEPS` · 'eintrag-word'). While the hold's chooser is up, the glyph gives way to
    its drawn ✕ (both paths always in the DOM). «Trupp finden» wears `#trupp-find` (people with a
    small lens — the owner's pick B, 29.09.2026; the flag in a reticle read as «ugly») on the Trupp tool's dock and in the finder's head — never the
    `#search` lens, which a search tile wears.
    (11) **Anwesend = the green tint, nothing else** (29.09.2026, owner pick B): no status dot, no
    green border. Not colour alone: present rows are the ones with the Ort + Uhr buttons, gone
    rows are `--done-opacity`, and the state word is in the row button's accessible name
    (`.sr-only`). The filter menu shows each state as a small row swatch (plain · tint · dimmed),
    the look the row has.
  - *Colour of a mention is not a state* (29.09.2026, owner pick A): every recognised word in the
    Verlauf – vehicle, partner, Trupp, person, material, group – is **bold `--ink`**
    (`.jr-link`), and in the composer one blue wash / one blue suggestion tint
    (`.jc-text-marks mark`, `.jc-phrase-link`). Red and amber are for alarms and warnings only; a
    routine «Ausrücken TLF» in the station red read as the loudest row on a page that carries real
    Atemschutz alarms. The composer's phrase chips wear the one corner (`--r-sm`), never a pill.
  - *One green per surface that means «saved / alive»* (29.09.2026): the Einsatz menu card's green
    is its «✓ Gespeichert» pill – no green stripe, no green fill, the other Einsätze' ages
    `--ink-dim`.
  - *A role or status TAG is neutral unless it IS a warning* (29.09.2026): the login roster's role
    is the `.ip-badge` recipe in ink 10% for every role (red read as «something is wrong with
    this account»). An Einsatz has ONE status tag, «Abgeschlossen» (29.09.2026, owner: «open is
    the default state») — no «Offen», no «In Arbeit», in any list; the backend's two active
    statuses are one state to the operator.

## Touch vocabulary

- **Touch vocabulary – one beat, one buzz, one wash.** The primary devices are gloved tablets;
  a new gesture reuses these or it teaches a second language. Any new touch interaction must:
  - *Hold on the 350 ms beat* when the hold **reveals or offers** – the icon-only hold-tooltip
    (`src/lib/holdTooltip.ts` · `HOLD_MS`) and the Eintrag hold (`src/lib/useHoldEntry.ts` ·
    `HOLD_MS`) share it, so every still hold answers alike. The holds that are not «reveal» keep
    their own documented numbers: `useHoldToDrag` arms a drag at 180 ms, `nodeHold.ts` arms at
    250 ms and fires destructively at 825 ms. Reuse a constant; don't invent a third window.
  - *Buzz on arm, and only on arm* – `buzz()` from `src/lib/haptics.ts`, always 12 ms, at the
    moment a held gesture becomes something (tooltip appears, drag latches, chooser opens, magnet
    dwell engages). Never on taps, successes or errors; never a pattern or a second duration
    (`navigator.vibrate` is Android-only, so anything expressive is inaudible to half the fleet).
    Older inline `navigator.vibrate?.(12)` sites (MapView/Whiteboard magnets, `nodeHold`) are the
    same 12 ms – new call sites go through `buzz()`.
  - *One hold ring, around the icon* – `HoldChargeRing` (`src/components/HoldTargets.tsx`, also
    `NodeDeleteChip`), fed by `useTimedProgress` off the **same clock as the timer**. Never a CSS
    keyframe: it drifts against the latch and, under `prefers-reduced-motion`, paints full on the
    first frame while the timer still runs. The ring haloes the glyph – never strokes across a
    label, and nothing may reflow under the finger mid-hold.
  - *Pressed state is the `--press` wash* – `background-image: linear-gradient(var(--press),
    var(--press))` on `:active:not(:disabled)`, so it composes over any background colour.
    **Nothing moves**: no scale, no translate – motion on press reads as lag under a glove.
  - *Hover is mouse-only* – every `:hover` rule sits inside `@media (hover: hover)` (app-wide
    since 28.08.). A tap leaves `:hover` stuck on what it hit, which reads as a selection state
    the surface does not have. `@media (pointer: coarse)` in `20-touch-floors.css` is the other
    instrument: it grows a target, it does not style one.
  - *A control whose press-and-hold IS its own gesture spreads `data-holdaction`* (the shared
    hooks already do), so the global hold-tooltip never claims it and asking «what is this»
    can never also do it. `useHoldRepeat`, `useHoldEntry`, `useNodeHold` and `useLongPress` return
    the attribute WITH their handlers (08.10.2026): spread the props, and wrap `onPointerDown`
    after the spread when a handle needs more. A bare `.press(…).onPointerDown(e)` call drops it
    (the Plan's Messen nodes did, and popped «Gedrückt halten zum Löschen» mid-delete).
