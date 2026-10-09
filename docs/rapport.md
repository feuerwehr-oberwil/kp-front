# The Rapport

What the printed Einsatzrapport carries (`src/lib/report.ts`, `src/lib/reportPdfDirect.ts`,
`src/lib/auswertung.ts`, `backend/app/report_pdf.py`, `backend/app/kroki.py`). Moved here from AGENTS.md on 2026-10-08,
wording unchanged.

## What the figure pages carry

- **What the Rapport's figure pages carry (18.09.2026).** The **Kroki is the picture**; everything
  else is opt-in or earns its page. Four rules, each from a printed review:
  - **Objektpläne are OFF by default** (`report · defaultReportOptions.annotatedPlans`). A linked
    sheet counts as «annotated» the moment the Karte's objects project onto it, so «on when there
    are any» stapled every linked plan to every rapport. They are reference material the station already owns.
  - **The Gebäude is its own section** (`options.gebaeude`, on), not one of the «Pläne»: it
    carries the Einsatz's own work. Only storeys with content print
    (`reportPdfDirect · usedStackFloors`); an untouched stack prints no page.
  - **A legend line says what the thing IS** – «Art · Bezeichnung · Status»
    (`symbols · symbolLegendText`), for every symbol. ⚠️ Not `symbolCaptionText`: the screen's
    value-only caption is an answer without its question once lifted into a legend. A symbol's own
    `caption: 'off'` is a screen declutter and is not read; only «Beschriftungen aus» silences it.
    A «Gelöscht / erledigt» symbol ends its line on that Status with its time («Feuer · gelöscht
    20:40», 24.09.2026) and prints grey, never absent.
  - **One figure-page template** (`report_pdf · figure_pages`): heading, then the muted «Einsatz ·
    Stand …» line, picture, legend – for the Kroki, a plan sheet and a Gebäude page alike. A new
    kind of figure page joins that list; it does not get a layout block of its own. Orientation is
    per kind ON PURPOSE: the Kroki is a free crop (the operator's choice), a plan sheet has the
    shape its author gave it (the bitmap decides).
  - **An attached Leitung end is coupled by the SERVER** (`kroki · _snap_attached_ends`, fed by
    `startAt` / `endAt` + the entity `id`; a branch off a Teilstück by `startAtLine` / `endAtLine`
    onto the fork's prong tip – `_snap_line_joints`, one geometry with the glyph: `_fork_dims`). The client has no projection and ends the line on a
    fixed ground footprint; the glyph is sized in pixels, so only the sheet's own view can land the
    end on it. ⚠️ And the fallback fit mirrors the PANEL: the ceiling is
    `report · krokiFitMaxZoom` (20; 21 for a COMPACT Lage under 30 m – one level past the basemap's
    last sharp one, so a single-building cluster is not 15 % of the sheet). That is a MapLibre
    camera zoom, one level tighter than the 256-px projection: `report_pdf · _kroki_fit_max_z` = +1.
    On paper the count badge is a WHITE chip like the storey badge – the numbered legend discs are
    the only dark marks on the sheet.

## The Auswertung sheet (09.10.2026, F7)

- **A debrief lives on paper, not on a screen** (owner: «maybe just on the pdf export?»). The
  optional «Auswertung» is the LAST sheet of the Rapport, landscape: key figures, swimlanes, and a
  pointer «Lehren / Sicherheit: siehe Seite 1» – the Lehren themselves print once, on page 1 with
  the signed record. It is internal – the signed part above it is what leaves the station, so it is the sheet
  that comes off the stack. `ReportOptions.auswertung` is ON for the Rapport and OFF for the
  QR-Erfassung's own PDF; a viewer link cannot make a PDF at all.
- **Derived on the client, printed by the server.** `lib/auswertung` reads the record where the
  ISO stamps are and sends minute offsets + finished strings in the deployment's language
  (`report_pdf · AuswertungIn`) – the same split as `personalSummary`. Nothing is estimated: a
  figure without its data prints «—», a vehicle that never reported vor Ort gets a dot, not a bar.
- **«Funkkontakte eingehalten» is the board's own rule.** An interval runs from the Eintritt or a
  contact (Kontakt, Druck, Alarm, Rückzug, Wiedereinstieg) to the next one or the Austritt;
  fällig past the interval, überfällig past interval + grace (`atemschutz · contactSeverity`). An
  interval still open counts only once it was already overdue. Watched = under PA, read per run
  off `paOn`/`paOff`. ⚠️ The clock also restarts at a REOPEN with no reading in the log
  (`reopenClocks · closedPauses`): the closed stretch is cut out, or it reads as an overrun. A
  Trupp taken off the Tafel ends at its `removedAt`; one that never went in is not drawn.
- **The axis is clamped** to alarm − 2 h … Einsatzende (or now) + 2 h, at most a week: one
  mistyped date must not squeeze the whole picture into a hairline. The figures still read the
  record as it is.
- **Greyscale first.** Most station printers are mono: fällig carries a sparse hatch, überfällig a
  dense cross-hatch on top of their amber/red, and the chart is canvas strokes (never a bitmap).
  Milestones are numbered diamonds with the words in a list underneath – the Kroki's rule, numbers
  on the picture and words in the legend.
