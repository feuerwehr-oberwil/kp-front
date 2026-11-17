# Tactical objects on the Karte and the plans

One object, two surfaces: how a tactical object is stored, anchored, projected and undone
(`lib/tacticalObjects`, `lib/planProjection`). Module rules live in `lib/gpsReturn`,
`lib/useGpsFollow`, `lib/useObjectStore`, `lib/objectDone`, `lib/georefTwins`,
`lib/lineAttachments`, `lib/replay` and `app/api/plan_scales.py`. Moved here from AGENTS.md on
2026-10-08 and 2026-10-18 (parity, the symbol pack), wording unchanged.

## Lage ↔ Plan parity and the symbol pack

- **Lage and Plan should stay as close as possible in every regard** – same tools, controls,
  and behavior. Only the implementation that *must* differ because of the drawing surface /
  relative coordinate system may diverge. Shared logic lives in `ToolDock`, `DrawEditor`,
  `SelectionBar` and `src/lib/lineStyle.ts` / `src/lib/selectionTransform.ts`; the renderers stay
  separate only for that surface-specific part.
- **The twins are one module each** (sweep wave 2, 24.10.2026), so parity holds by construction,
  not by review: the magnet of a line being drawn (`lib/useDraftMagnet` – line-start exception,
  start-radius claim, dwell, release only if armed, the «Angekuppelt» joints; each surface hands
  in only its projection and target walk, `lineAttachments · lineEndTargets` /
  `candidateAttachment`; the Lage's walk is `components/mapMagnetTargets`, its magnets
  `components/useMapMagnet`), the draft contract (`lib/draftMachine` – ✓ «Fertig», and
  the «Speichern · Verwerfen · Weiterzeichnen» question when an open drawing is left, 27.10.2026,
  which replaced the A6 tap-away auto-commit), «mit verbundenen Leitungen entfernen» (`lineAttachments · detachEnds`; the Lage sends
  it as ONE `draw.edit` per line, both ends in it – `detachDrawings` – so replay keeps both ends moved;
  since 14.11.2026 the «TLF hat 2 Leitungen» card asks «Nur Symbol» or «Mit Leitungen» first,
  `removalToast · askJoinedLines`, docs/undo.md › One delete rule),
  ⌘D (`lib/duplicate`), and the armed tool + per-team trails + note-panel closing rules
  (`useTacticalSelection · usePlacement`, `lib/useHiddenTrails`, `lib/useNotePanelClosing`).
- **A line's end mark stays on top while it is edited** (round 14.11.2026 #8, owner: «the -> isn't
  shown above the nodes»): the node at an arrow or Teilstück end is a hollow ring
  (`lib/lineStyle · endMarkIndices`, one helper for both surfaces) and the mark paints above it –
  on the Karte a DOM copy of the canvas head (`MapView · EditArrowMark`) and the fork's marker at
  `MARKER_Z.endMark`, on the Plan `.wb-arrowhead` / `.wb-line-fork` over `.wb-vertex`. Pointer-inert:
  the ring under it stays the grip.
- **A finger on an object pans, unless the object is selected or held** (duck sweep GESTURES.1/.2,
  owner 17.11.2026 – the Lage's rule on both surfaces). Touch or pen on an object that is not
  selected: a move pans the map / the board, a tap selects on release, a still hold of
  `HOLD_DRAG_MS` (180 ms, `lib/holdTimings`) lifts it with a buzz. A selected object, and any mouse
  press, drags past the 8 px deadzone at once. Lage: `useHoldToDrag` in `MapMarkers · pressMarker`
  (a Linie / Fläche / Kreis body has no drag there – the bar's ✥ moves it). Plan: every kind,
  Trupp chips, symbols, notes, Linien, Flächen, Kreise and a Linie's label (`useWbChipDrag`,
  `useWbBodyDrag`, the pan from `useBoardGestures · panFrom`). So a pan that starts on a Trupp
  never moves it and never stamps it a new time. A pan never deselects either: only a stationary
  tap on empty map / board does (`useMapActions` after `MapView`'s pan-click drop;
  `useBoardGestures · panUp`). The lasso is one-shot on both: after any box you are back in
  Auswahl (`useMapActions · onMarquee`, `useBoardGestures · marqueeUp`). A tap on a pile of compact
  glyphs (symbols, Trupps) fans it out on short spokes and the next tap picks one – nearest
  centre, never the top DOM node (`lib/labelPass · pileAt / fanOffsets`; Lage `MapMarkers`, Plan
  `useWbChipDrag · fan`, GESTURES.9). Nothing drags while a pile is fanned; a press beside it or Esc folds it, on both surfaces. A double tap on a
  named chip opens its name on both surfaces (GESTURES.10): a Notiz its inline text, a Trupp its
  rename – unless the Atemschutz board names that Trupp (`truppId`, no pen either). The Lage
  counts the two taps itself (`MapMarkers · namedDoubleTap`, the map's numbers from
  `lib/tapDragZoom`); the Plan keeps those chips out of its one-finger zoom (`useBoardGestures`).
- **Right-click means one thing** (GESTURES.13, 17.11.2026): on a node pad it is the hold's desktop
  twin – delete that point, with the hold's own floor (a finished Linie / Messen-Strecke keeps 2
  points, a Fläche 3; a draft may shrink to nothing), on the Lage, the Karte and the Plan, Messen
  included. On an object body it does nothing (no select, no drag); a right drag still turns the
  map. The Schichten / Zeitplan context menus are their own surfaces and keep theirs.
- **A tap on a node is the node's, never the map's** (round 15.11.2026): a node is dragged or
  held, a tap on it does nothing. On the Karte its click would bubble from the Marker to
  maplibre's container and insert a node under the finger (a selected Linie grew a stacked
  duplicate per tap, Messen and the open draft alike), so the node pads stop it on the marker
  element (`MapView · keepClickOnPad`; check: `e2e/node-pad-tap.spec.ts`). The Plan's `.wb-vertex`
  never had it: its pads take the pointer themselves (`useWbVertexEdit · vertDown`) and only the
  «+» inserts.
- **Nothing stays armed across a pause** (rare-user round 17.11.2026, C3 – `lib/useOnResume`, one
  hook for the Lage, the Plan and the Karte): when the app comes back from the background (the
  page visible again after it was hidden), the armed tool, symbol or shape is put down, «Mehrere
  platzieren» and «Zeigen» go off; a committable draft asks «Speichern · Verwerfen ·
  Weiterzeichnen» exactly as leaving it any other way. No idle timer; the Wiedergabe is untouched.
- **What this device makes, it sees** (F3, 17.11.2026): a symbol, shape, note, drawing or Trupp
  marker placed into a layer this device has switched off switches that layer back on
  (`IncidentWorkspace · revealLayer`, the ordinary `layer.toggle`). While a CONTENT layer –
  Taktische Zeichen, Fahrzeuge, Skizzen & Notizen – is off, the «Ebenen» tile carries an amber
  dot (M6, `lib/layerPreset · contentLayerHidden`); a reference layer off, or the preset, never
  marks it (owner 05.10.2026).
- **The armed tool's readout is the first tile of its dock** (`ToolDock · armed`, `lib/armedTool ·
  armedReadout`; 3am sweep point 3, 23.10.2026 – owner: «a small little info thing … that now you're
  placing symbol XYZ and that's it» – a pill at the bottom centre until the button round's picks
  14 + 15, 17.11.2026, and on the phone the owner's WIP of 16.11.: «ideally we don't need a 4th
  line»). On the Karte, the Einsatz map, a Plan and the Tafel, tablet and phone: the tool's glyph
  (a symbol's own SVG, a Form's preview) over its name («Feuer», «Linie», «Absperrkreis»), a plain
  tile – no fill, no sentence, no button, pointer events pass through; the input mode is the lit
  toggle beside it. ONE builder for both surfaces (`armedReadout`), so Lage and Plan name a tool
  alike. The symbol tool has a dock for it: [Unfall · «Mehrere» («Mehrere platzieren») · ✕
  «Abbrechen»], worded by «Beschriftung»; the way out is that ✕ or Escape on the Karte and the Plan alike (27.10.2026: with «Mehrere platzieren» on, the
  Plan's Escape did nothing and there was no ✕ – no way to stop placing Durchgänge). **Escape is one
  ladder on the Karte, the Plan and the station viewer** (`lib/hotkeyRoute · routeEscape`, duck sweep
  17.11.2026): the top layer (Ebenen, Ansichten, the Passung dock, the viewer's search) → what is
  half-made (a placement, a rotation, a line or circle being laid, the Koordinaten crosshair) → the
  armed tool, with no draft too (the Plan kept an armed Notiz, Trupp, Mehrfach or Messen until then)
  → the note panel → the selection; one layer per press. A sheet, menu or card over the surface, and
  the ✥ ⟳ mode, take their Esc first and alone (ui-conventions › Overlays). Delete/Backspace has the
  same guard: never from a field, a dialog or a menu (`lib/hotkeys · keyOwnedElsewhere`). The other tools keep their option docks (Freihand ↔ Punkte, «✓ Fertig» – the one commit, ui-conventions › Close and commit –,
  Strecke ↔ Fläche, Trupp finden) – each led by the readout. Messen's dock has no readout tile, on
  any size: its results panel names the tool (sweep 30.10.2026 #3). On a phone a busy dock scrolls
  with its ✕ sticky at the end, like every dock; a short one shares its line with the floating row
  (phone-layout.md · «The floating row»).
- **One detail card, one set of controls** (`components/ContextPanel`, owner decisions
  31.10.2026). The Karte and every plan open the SAME card for a symbol, so a control added or
  removed there is added or removed on both surfaces. «Erledigt» is ONE toggle in the foot, in
  the same spot whether the matter is open or over: set, the tile stands pressed (check, green
  tint) and a tap reopens it; when it was set is the header's subtitle («Schadenlage · erledigt
  10:57»), which a read-only card shows too. Both directions stay ordinary undoable prop edits
  (`lib/objectDone`). There is no «Auf {plan} zeigen» / «Auf Karte zeigen» door any more: every
  object is drawn on the Karte and on its linked plans alike, so the door showed the same thing
  again. And no «+ Feld»: a symbol's rows are its preset; a free row an older Einsatz carries still
  renders with its editable key and ✕, but nothing adds a new one – a remark goes into Notizen.
- **A new line starts from the plain default, always** (`useMapDrawing · DRAW_DEFAULTS`,
  `usePlanDraft · INK_DEFAULTS`, 23.10.2026): the surface's colour, width, solid, no marker, no
  arrowhead – whatever the last line was edited to. Until then the DrawEditor wrote every style
  edit back as the next line's template, so an Absperrung's chain marker rode into the next hose
  line. Styling is done in the editor, after the draw, on that one drawing.
- **Tactical symbols are our own pack.** `public/tactical-symbols.json` is KP-Front-authored
  artwork following the FKS Faltkarte conventions, generated by `tools/gen_symbols.py` – edit
  the generator, never the JSON, and re-run `python3 tools/gen_symbols.py emit` (a `review`
  mode renders a sign-off grid). Names/categories are compatibility keys referenced across
  appConfig/copy/backend config; keep them stable.
- **A measured value IS the mark** (the Messpunkt, 26./27.10.2026). A preset's `readout`
  (appConfig) names the fields that are measured values («CO», «Ex», «O₂», «H₂S»); such a symbol
  draws as one pill – a small Messgerät and the worst gas – instead of its glyph, on the Karte, the
  Plan and the Gebäude alike (`lib/symbols · symbolReading`, `TacticalSymbol · measured`). The
  worst gas is the one at the highest alarm stage – on a tie the one furthest past its limit –
  so an «Ex 12» is never hidden behind a harmless «CO 14». The preset's `alarm` holds the detector's two stages per gas: calm ink below
  A1, amber from A1 (Voralarm), red from A2 (Hauptalarm); O₂ alarms both ways. After the preset's
  `staleMin` the colour moves to the outline and the age shows («18′»). A point not yet measured
  is the dashed pill with the icon alone. The label pass books the pill as the glyph's footprint –
  it is never suppressed – and every other place that prints a value keys it (caption «Alle», the
  printed legend), because a bare «180» names nothing.
- **A vehicle says where it comes from** («Herkunft», owner pick 3A, 05.11.2026). Every driven
  vehicle preset (the ones with «Fahrer»: Fahrzeug, Drehleiter, Hubretter, Grosslüfter, Boot)
  carries `Herkunft` as its second field (`appConfig.symbols.originField`); a live GPS vehicle
  keeps it in its override row (`useVehicleLayer · VehicleOverrides.herkunft`, merged per field
  like the Fahrer). The panel row is the shared station-list control (`ContextPanel · FieldControl`:
  the dropdown with free typing, a plain text field while the station lists nothing) over the
  station's ONE list `fleet.origins` (`symbols · vehicleOriginOptions`, no bundled default);
  empty = own Feuerwehr, and the box says «Eigene Feuerwehr». On the Karte and the Plan it is never the caption: it is
  a small grey last line in the caption box (`symbolOriginText`, `TacticalSymbol · origin`),
  booked by the label pass together with the caption (`symbolCaptionBoxText`), hidden with
  «Beschriftungen aus». Setting it never re-files the Fahrer (`entityEdit ·
  rosterFieldsToRefile`): no Bemerkung reads it.
- **A Messpunkt keeps its readings** (`SymbolProps.readings`). Every field commit that changes a
  measured value appends a row (`recordReading`); rows are never rewritten, so two tablets merge
  as a union (`lib/mergeWorkspace · withMergedSymbolReadings`), and «one radio report typed gas by
  gas is one reading» is a display rule (`readingRows`). «Gleich gemessen» under the fields
  (owner pick 4A, 10.11.2026; an ordinary button at the right edge) appends the values as they stand with the time now – a Nachmessung
  that confirms «CO 0» is a reading, and the point stops ageing. Every appended row is ONE act on
  both surfaces (`lib/readingLog · readingAct`, called by `useMapActions · commitEntityFields` and
  `Whiteboard · commitAnnoFields`): the props in one undoable step named by the reading's
  sentence, and that sentence as a Verlauf row ([`verlauf-coverage.md`](verlauf-coverage.md) ›
  Messungen); the Rapport prints the readings as their own section ([`rapport.md`](rapport.md)).
- **A measured field holds a number, or says why not** (owner pick 3B, 10.11.2026, `lib/symbols ·
  measuredOf`). The panel's box takes digits and one decimal mark (`cleanMeasured`,
  `ReadingParts · MeasuredField`); «über Messbereich» is the shared `TickRow` beside it – a bare box
  named per gas, its words once as the column's caption above the first gas (`ReadingOverHead`,
  owner review 10.11.2026) – and is
  stored IN the value as a leading «>» («>100», a bare «>» without a number) – ⚠️ no second synced
  field, so the history rows, the merge and an older build carry it unchanged. Over range draws,
  sorts and records as the Hauptalarm (`readingState` → `stateLevel`: A2, past every measured
  value, the bar's end). Free text from before the box took numbers only still reads: «>…», «≥…»
  and «OL» are over range, anything else («ca. 60», «180 ppm») is `unreadable` – amber, sorted as
  A1, «Unlesbar – Zahl eingeben» under the box, the text kept until somebody types over it.
  Never calm, never a crash. The panel shows a calm/amber/red bar under each
  gas, the decimal keypad on each gas field, an ⓘ «Grenzwerte» built from the preset's `alarm`
  (`ReadingInfo` – limits and colours only, never what to do) and the list under the fields; the
  Gebäude lists every Messpunkt beside its storey (`StackReadings`), and the «Messungen» chip – on
  the Karte and every plan – wears the worst value and lists every Messpunkt of the Einsatz,
  worst first, wherever it is anchored (`lib/readingsList`, `ReadingsChip`); a row goes to the
  point on its own surface. ONE order everywhere (`compareReadings`, 28.10.2026): stage, measured
  before empty, fresh before stale, how far past the limit, newest reading – with an «Erledigt»
  point below every live one (`readingsList · doneLast`, ENT.3 17.11.2026), so the chip never
  wears a cleared room's A2. Erledigt recedes like every symbol: the pill goes to the done look
  (`.sym-pill.done` – neutral plate, dim ink, the value still legible) on the Karte, every plan,
  the Gebäude list and the chip; the printed Kroki greys the glyph the same way (`kroki · _greyed`).

- **A Leitung's Wassertransport and the pumps it draws** (04./05.11.2026). One section
  (`components/WaterRelay`) in two hosts: Messen › Strecke and a drawn Leitung's «Messung»
  (`DrawEditor`), both driving `lib/useRelay` over the pure engine `lib/hydraulics`; the
  assumptions live on the line (`Drawing.relay`, its Ø in `hose`), every edit an ordinary
  `draw.edit`. **Lage only** – a plan sheet has no ground and no height profile, so there is no
  Plan twin to keep in parity. The Leitung's switch **«Pumpen auf Karte»** (`relay.showPumps`,
  owner 05.11.2026: «the Leitung draws its own pumps»; the row under the result reads «Auf Karte»,
  the Messung's own word, with the full name as its accessible name) makes the line draw its calculated pumps
  as the pack's Motorspritze (`RELAY_PUMP_SYMBOL`): ⚠️ DERIVED, never entities (`lib/linePumps`).
  Every render plans again along the stored path on the shared height profile
  (`lib/profile · loadProfile`, the cache the editor's Messung reads too), so the pumps move with
  the line and every changed assumption, and there is nothing to duplicate – a second «on» is
  still the one set. On the map `RelayPumpMarkers · LinePumpMarkers` runs the editor's own
  controller per line; while that Leitung's Messung shows its relay the panel's live pumps stand
  in for them (as Motorspritzen too, so the switch shows what it does). Each wears the chart's
  name for it (P1, P2 …, `useRelay · pumpLabel`) – the glyph alone read «MS 2» on every pump
  (Manuel 09.11.2026). A drawn pump is DRAGGED along its line and pinned there
  (`relay.pumps[i].atM`, the chart's own pin, one undo step on release, no Verlauf row); a tap
  selects the Leitung with its «Messung» open (`useRelay · askLineMeasure`). Paper prints the same pumps
  (`krokiPayload` adds `drawnPumpEntities`; `readyDirectReportPayload` awaits the profiles first)
  and the Rapport's Kroki preview shows them. A profile once fetched answers offline too, after a reload
  (the service worker's `height-profiles` cache, docs/sync-and-offline.md); none at all (a path
  never fetched online, outside CH) plans on flat ground, exactly as the editor then does and
  says («Ohne Höhenprofil gerechnet»). Messen has no
  switch: its pumps are the panel's while it measures, and «Als Leitung auf die Karte» carries the
  relay onto a Leitung WITH the switch on (owner 05.11.2026, `useMeasure · adoptedRelay`), so
  the pumps Messen showed stay on the map. The one-shot «Pumpen als Symbole setzen» it
  replaced (#536, 04.11.2026) placed ordinary Motorspritzen – those stay ordinary symbols.

## One object, two surfaces

- **One object, two surfaces — there are no twins any more** (10.09.2026). A tactical
  object is ONE record in one collection (`src/lib/tacticalObjects.ts`), carrying up to two
  bodies of the same thing: `entity` XOR `drawing` is what the Karte draws, `sheet {planId,
  anno}` is what one plan sheet draws. The three legacy collections (`entities` / `drawings` /
  `board`) survive only as VIEWS of it, and the blob still carries them so an older client can
  read a newer incident.
  - **The sheet body's PRESENCE is the anchor.** An object hand-placed on a sheet carries
    `sheet`: the sheet coordinates are its truth, and its map body is BAKED through the plan's
    georeference (`bakeGeoBody`) and re-baked when that fit changes. An object hand-placed on the
    Karte carries no `sheet` at all: geo is its truth, and a linked sheet draws it by PROJECTING
    it through the same fit (`src/lib/planProjection.ts`). Both derivations are pure, and they
    are **inverse in geometry AND in absence** — a projected anno handed back off a sheet becomes
    the stored sheet body verbatim, so an asymmetry between them would rotate, resize or displace
    the object a little on every flip, and an absent field materialising as `0` or `''` would
    invent one. Where one converts (the sheet's own turn into and out of the paper's frame, for
    BOTH bearings; metres into sheet fractions and back, at the same default an unsized object is
    drawn at) the other undoes it, and the comment at each says so. ⚠️ The absence half is
    normalised on the way BACK, not on the way out: an object with no bearing genuinely IS turned
    by `rotationDeg` in the paper's frame, so the projection has to state that — and «points
    north» is the same fact as «has no bearing», so the bake returns the shorter one
    (`turnedToGround`). Without it every ordinary unturned Fahrzeug acquired `rotation: 0` on its
    first flip. ⚠️ **The DOC seam converts bearings too** (24.09.2026, Feueralarm-Übung 23.09.):
    a Karte write hands back the GROUND bearing, and `annoAfterMapEdit` once spread it into the
    PAPER's frame for every sheet-anchored object, changed or not — each «Karte write → bake»
    cycle turned the glyph by −`rotationDeg` (a Lüfter reached 66 735°, and turning one turned
    all). Now `sheetBearings` keeps an unchanged bearing verbatim and sends a changed one through
    `turnedToSheet`; `applyDocToObjects` hands an object whose map body did not change back as
    the same record; both conversions answer in [0, 360); and the load gate
    (`sanitizeWorkspace`) brings any stored bearing into [0, 360) by mod alone.
    Pinned by `sheetBearingRoundtrip.test.ts`. A field that cannot be said in both units — a note's width, a label's nudge —
    does not cross at all: it is preserved through the bake instead (`BAKE_PRESERVED`), because a
    number that means two distances is worse in the record than no number.
  - **Last hand-placement owns the truth.** A drag flips the anchor to the surface it happened
    on: dragging a sheet-anchored object on the Karte DROPS its sheet body, dragging a map object
    onto a sheet CREATES one. Both seams (`applyDocToObjects`, `applyBoardToObjects`) therefore
    read a document as a GESTURE rather than as the truth, in four readings each — unchanged is
    nothing, a prop edit writes through to the OTHER body, a positional edit flips the anchor,
    and absence deletes the whole object, because deleting an object deletes the object.
    ⚠️ The flip is between the Karte and PAPER, never between two sheets (24.09.2026): a move of
    the Gebäude's ink on a sheet it is lent to is written back INTO the Gebäude through both fits
    (that sheet's → ground → the stack's), storey and per-vertex storeys intact, and the Gebäude
    keeps it. It used to flip, and a 0.3° ⟳ on Modul 1 took a 1. OG Leitung off its storey (prod
    23.09.2026). Only a HAND drag that leaves the Gebäude's paper (a Brand dragged out onto the
    street), or a stack with no fit to write through, still re-homes it to the sheet it happened on.
  - ⚠️ **A MACHINE write never flips an anchor.** Only a hand places something. The live-GPS pass
    re-routes attached Leitungen several times a minute, and read as a placement it tore
    plan-drawn hoses off their sheet with nobody touching anything; such writers pass
    `gesture: false` and their position crosses through the fit instead. Both store writers take
    it — `setDocRaw` and, since 24.09.2026, `setBoard` (it hard-coded «gesture»): a plan ↶/↷
    restoring a snapshot (`usePlanStacks · planStepAt`, `useBoardDoc`), the Trupp sweeps that move a marker
    (`settleAtHoseEnd`, `unlinkTruppLine`), a Gebäude amend and a storey removal. A writer that
    rewrites what a sheet OWNS hands the lent annos back untouched (`tacticalObjects ·
    withOwnAnnos`) — the Gebäude amend carried the Karte's projections through the old building
    frame and they came back «moved». So does «Geschoss entfernen» and the ↶ of «Geschoss
    hinzufügen» (24.09.2026, `stackFloors · removeStorey` / `withoutOwnOnStorey`): a Karte object
    SHOWN on a storey is not the storey's, and swept out of the view it was deleted outright. It
    stays on the Karte and simply finds no tile. The removal's confirm asks only about what the
    SAME sweep loses (`removeStorey · lost`, `lib/storeyRemoval`) — «n Markierungen … entfernt oder
    gekürzt» — and a storey showing only Karte objects goes without asking; the toast still undoes
    it. And the seam honours it per object: a lent anno
    handed back exactly as shown folds to the SAME record (`applyBoardToObjects`), never through
    the bake — which lost a note's text and laid a store step for nothing.

- **Presentation stays equivalent, and nothing is lent that is owned.** Each surface draws the
  other's objects with its OWN native chrome and sizing (map `symPx`, board `symBase`) — no
  projection tone, no reduced opacity, no twin-only band — and every capability the surface has
  applies: selection, the `SelectionBar`, the marquee, the magnet, the fat-finger fan, Delete.
  A sheet is never shown its own objects back through the projection, nor a sibling sheet's
  — with ONE exception: the Gebäude stack's ink shows on every other linked sheet, its storey as
  a badge (14.09.2026, `planProjection · projectOntoSheet`), because the building is where a
  Brand is marked and the Übersicht is where it is read. The stack itself never shows another
  sheet's ink, and plan A's work never clutters plan B. What IS lent is only what is not a record
  — the live vehicle and responder feed (`planProjection · liveOverlay`, `PlanLiveLayer`),
  read-only but for the one gesture it always had: dropping a Fahrzeug writes the same
  held-in-place override the Karte writes.

- **A Verlauf photo on the Karte is an object; on a sheet it is only shown** (F16, 08.10.2026).
  «Auf Karte setzen» (lib/photoGeo) places an ordinary `kind: 'photo'` entity at the position the
  picture's EXIF names, with its view cone from `heading`; it names its picture by Verlauf row +
  index (`photoOf`), never by URL, because a picture placed offline is a session `blob:`. The
  projection still answers `null` for it — media, not a place on the paper — and a georeferenced
  sheet SHOWS it read-only instead (`planProjection · photoOverlay`, `PlanPhotoMarks`): a tap
  opens the picture, moving or removing it is the Karte's. Not on the Gebäude stack (a GPS fix
  has no storey), and nothing at all on a sheet without a georeference. Where a phone hands over
  a position and where it does not: the header of `lib/exif.ts`.

- ⚠️ **The aspect the fit is solved in is its own stored fact** (`measuredArByPlan`), NOT
  `PlanScale.ar`. `ar` is half of a pair — a sheet's ground width is `ar · mPerU` — so
  correcting it in place silently rescales every measured distance on that plan. The measured
  aspect says only «this sheet is this shape»; correcting it re-solves the fit from the SAME
  pairs (a pair is an aspect-independent statement), so `fitSignature` changes and the ordinary
  journalled re-bake does the rest. The surface holding the bitmap writes it, once per sheet per
  session, past the same 2 % drift calibration staleness uses. It matters because a replaced
  Modul PDF leaves a stale `ar` that staleness CANNOT catch (it is measured against the very
  aspect being looked for, and the pairs were fitted at the same wrong one), and a wrong aspect
  is now a wrong position in the record rather than a tilted picture.

- ⚠️ Known limitation, ACCEPTED and not to be re-opened without a decision: the flip is a FIELD
  REMOVAL, and `mergeWorkspace` merges an object field-wise last-writer-wins — a concurrent edit
  still carrying the dropped sheet body brings it back. Absence cannot say «deliberately
  dropped»; a tombstone or an explicit anchor enum could, and that is a schema change nobody has
  asked for. Replay is unaffected: it folds VIEWS, so a sheet there shows only what was recorded
  on it.
