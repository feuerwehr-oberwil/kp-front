# Board templates – the Tafel's pages

The Tafel has a **page strip**: «Skizze» (the free board, unchanged) plus the pages a board
template offers under «+ Seite». The bundled set is the FKS «Erste Führung» poster and five sheets
from the FKS Handbuch Führung Grossereignisse (09/2022, Kap. 8). A station can replace that set
with its own copy, distributed the same way as the checklists. Built 10.10.2026. The owner's
decisions behind it are in the research notes, §6: strict 1:1 with the FKS poster, a live mini
Karte in the Lagekarte box, spreadsheet keys, an empty Tafel at the start, and a station set that
replaces the bundled one.

| Where | What |
|---|---|
| `src/data/boardTemplates/fks-erste-fuehrung.json` | The bundled set. It is also the starting point of a station copy. |
| `src/lib/boardTemplate.ts` | The client's model of `board-template/1`, `labelText` and the tolerant `isBoardTemplate` gate. |
| `src/lib/boardForm.ts` | A page added to an Einsatz: its snapshot, its values and the edits. `formForPdf` resolves it for print. |
| `src/lib/boardFormNav.ts` | The keyboard, as a pure function. |
| `src/lib/boardTemplates.ts` | Loads `tafel:*` datasets through IndexedDB, with the bundled set as the fallback. The Whiteboard reads it when the Tafel is first shown, never at boot. |
| `src/components/TafelFormPage.tsx`, `TafelPageStrip.tsx`, `MiniKarte.tsx` | The page, the strip and the Lagekarte box. |
| `backend/app/board_templates.py` | The pydantic contract (`extra="forbid"`). |
| `docs/board-template.schema.json` | The JSON Schema generated from that contract (`just board-template-schema`). A pytest pins the two together. |
| `backend/app/admin_board_templates.py` | The `schema \| example \| validate \| load \| push \| show` CLI. |
| `backend/app/report_board.py` | Draws each page in the Rapport. |

## How the Tafel uses a template

- **A new Tafel starts empty.** The strip shows «Skizze» and «+ Seite», and nothing else. No
  page is forced on anyone, and there are no «Womit beginnen?» cards.
- **«+ Seite»** lists the pages of the station's set, each under its template's title, by
  title only. The FKS sheet numbers (8.1 …) stay in the template's `source` and in this doc,
  never in the app (owner, staging round 2). A page that is already on the Tafel is marked «schon da». Tapping it goes to
  that page instead of adding a second copy.
- **A page is ONE board anno** of kind `form` on the Tafel's own sheet (`board['tafel']`). The
  anno carries the page *snapshot* and everything written on it. So adding a page, every
  committed cell and removing a page are each one ↶ step on the Tafel's history, and a page syncs
  and works offline like a note. The Whiteboard keeps the pages away from everything positional
  (`Whiteboard · formAnnos`). Every ink commit gets the pages put back on, so a stroke can never
  drop one. A page, or any board object of a kind a build does not know, is a **passenger**: kept
  untouched at the load gate, in every merge and save, and guarded on the server against builds
  that predate it (AGENTS.md › Offline, sync and the record).
- **Two devices on one page** merge cell by cell (`lib/boardFormMerge`): different cells both
  survive; the same cell changed on both keeps the later edit (each cell carries the server-clock
  time it was committed, `t`) and writes a Verlauf row naming the page, the cell and both values.
  A cell that has the keyboard follows the other device's value until it is typed into.
- **The audit** hears the cells that changed (`board.edit` · `form.delta`), not the whole page.
- **Values are keyed by id** (section, box, column, row), never by position or label. A station
  can rename «Wer» to «Zuständig» without losing a word.
- **The snapshot.** When a page is added, the page as it stands in the station file is copied
  into the Einsatz, together with the template's id and version. Later edits to the file never
  change an open or archived Einsatz, nor its Rapport.
- **Switching pages**: tap a tab, or press PageUp / PageDown while no field has focus. There is
  no swipe, because a swipe pans the board. The strip is the app's segmented control in its tabs
  form, on a bar of the top bar's make, right under it. Which page a device shows is local to
  that device: remembered per Einsatz in IndexedDB (`lib/tafelPages`, never in the workspace),
  restored when the Tafel opens, «Skizze» when the page is gone.
- **Unsaved typing is never lost**: a cell writes on blur, when the app goes to the background
  (`visibilitychange`, `pagehide`) and when it unmounts. On a closed Einsatz the draft is parked
  on the device (`lib/draftKeep`) instead of written.
- **Removing a page** asks first when something is written on it. ↶ brings it back either way.

### The keyboard (like a spreadsheet)

| Key | Does |
|---|---|
| Enter | Commits the cell and moves **down**: the next row, same column. In a Problemerfassung box it moves to the next line. On the last line it moves to the box's empty line. |
| Enter on the empty trailing row | Leaves the list for the next section's first cell, so nobody gets stuck in a list. |
| Tab / Shift+Tab | Moves **across**: the next column, or the next box to the right (Front → Ordnung → Sanität → Spezialprobleme, staying on the same line). It wraps to the next row and then to the next section. Shift+Tab is the exact way back. |
| Shift+Enter, Alt+Enter | A line break inside the cell. On a touch screen a «Zeilenumbruch» key (↵, 44 px) sits in the focused cell. |
| Esc | Restores the stored value. A second Esc lets go of the field. |

- In a «Wann» (`time`) cell, `1124` is stored as `11:24`.
- Enter on a row that has words and an empty Wann fills in the current time. This is part of the
  same commit, so ↶ takes it back.
- An IME composition (Safari: `keyCode` 229) never commits or moves.
- **Every box you see is writable.** A table's ruled empty rows on screen are real rows you can
  type into (as many as the section's `height` leaves after the written ones); there is no
  filler. Under the Abspracherapport's pre-printed rows, an added row has Bezeichnung and Ort as
  free text; its Signatur stays blank.
- Every list has exactly one empty trailing row. A row emptied on commit is dropped. A trend or
  a tick on its own is not content.
- DOM order is template order, so the iOS ↑↓ bar follows it. Pre-printed cells (Signatur,
  Bezeichnung, Traktandum) are text, not inputs, so neither Tab nor the iOS bar stops on them.
  `enterkeyhint` is «next», and «done» on the last field.

### The Lagekarte box

A `map` section shows a small, **read-only, live** view of the Einsatz-Karte (`MiniKarte`). It
uses the same base and reference layers, the same symbol images, the same placed objects and the
same drawings, framed on what the Einsatz has placed. A tap opens the Karte.

It is cheap on purpose:

- The MapLibre instance exists only while a page with a map box is on screen. It rides the
  Whiteboard's lazy chunk; a chunk of its own split shared modules out of the App chunk and cost
  the cold start ten requests.
- It takes no input (`interactive={false}`, `inert`).
- It refits only when the extent of the Lage moves.

In the Rapport, the box gets a server-side Kroki render of the scene at print time,
auto-framed and without captions.

## The Rapport

- **Pages.** Each form page prints on a sheet of its own, in its own layout, right after the
  Aufträge. The Erste Führung prints as the A3 poster on A4 portrait, which has the same
  proportions. Sheet 8.1 prints landscape.
- **Empty boxes** print as ruled empty boxes, so the paper can still be filled in by hand.
- **Overflow.** Nothing written is cut off. A box shrinks its type down to 6.5 pt, and whatever
  still does not fit continues in a «Fortsetzung» table that flows over as many pages as it
  needs (`report_board · Continuation`).
- **Header** labels (Einsatz, Adresse …) print in the report's language.
- **The Skizze** prints as a blank-base plan page when it carries ink. That closes the old «the
  Tafel's ink never reaches paper» gap.
- **Switch.** Everything above sits behind one entry in the print menu, «Tafel – Seiten (n)»,
  which is on by default.
- **Fonts.** Trend arrows (➚ = ➘) are drawn as vector arrows, because Helvetica has no glyph for them. Soft hyphens (`­`)
  in a label split it where the poster does, as in «Patienten-sammelstelle».

## Writing a station template

1. **Start from the bundled file.** Download it from `/admin › Tafel-Vorlagen` («FKS-Vorlage
   herunterladen»), or copy `src/data/boardTemplates/fks-erste-fuehrung.json`.
2. **Change the copy.**
   - Give it your own `id` (for example `fw-oberwil`) and raise `version` whenever you change it.
   - Keep the ids of what you keep.
   - Reorder the arrays to reorder the page.
   - Delete a section or a column to drop it, or set `hidden: true`.
3. **Store it.** Put it in the private data repo as `tafel/<id>.json` and list it in
   `tafel.manifest.json` (`admin_board_templates example` prints the shape).
4. **Check it.** Run `uv run python -m app.admin_board_templates validate tafel.manifest.json`.
   The check is strict: an unknown key is an error, with its path, never silently ignored.
5. **Publish it.**
   - `just board-templates-push tafel.manifest.json --base https://… ` (with `KP_ADMIN_SECRET`)
     uploads every template as `tafel:<id>`. The `tafel:*` datasets the manifest does not list
     are only **listed** as prune candidates (an /admin upload looks the same); add `--prune` to
     delete them. `--dry-run` shows both lists. An empty manifest is refused.
   - A template's `id` must match `^[a-z0-9][a-z0-9-]*$` and equal its `tafel:<id>` slot; the
     server refuses anything else.
   - `/admin › Tafel-Vorlagen` does the same for one file.

⚠️ **A station set replaces the bundled one.** As soon as one `tafel:*` dataset is stored, only
the station's templates are offered, and «Erste Führung» comes back only if the station copy
contains it. Removing the last station template brings back the bundled set.

### The format (`board-template/1`)

The schema is [`board-template.schema.json`](board-template.schema.json).

**Labels.** A label is either a string or `{ "de": …, "fr": …, "it": …, "en": … }`. German is
required and is the fallback.

**Ids.** Every id matches `^[a-z0-9][a-z0-9-]*$`. Ids must be unique among their siblings.

**Template**

| Key | Meaning |
|---|---|
| `schema` | Always `board-template/1`. |
| `id` | The template's id. |
| `version` | Raise it on every change. |
| `title` | The template's title. |
| `source` | Optional. Printed in the page footer. |
| `pages[]` | The pages. |

**Page**

| Key | Meaning |
|---|---|
| `id`, `title` | The page's id and title. |
| `code` | Optional. A sheet number, kept as metadata only; the app never shows it. |
| `paper` | `portrait` or `landscape`. |
| `columns` | `1` or `2`. A phone always uses one column. |
| `header` | Switch for the Einsatz · Adresse · Alarm · Einsatzleiter line. |
| `hidden` | When true, the page is not offered. |
| `sections[]` | The page's sections. |

**Every section** has `id`, `type` and these optional keys:

| Key | Meaning |
|---|---|
| `title`, `subtitle` | Headings. |
| `span` | `2` takes a whole row of a two-column page. |
| `height` | Height on paper in ruled rows. For a table, it is also how many empty rows it prints. |
| `hidden` | When true, the section is not shown. |

**Section types**

| `type` | What | Keys |
|---|---|---|
| `quad` | Boxes with one problem per line (Problemerfassung) | `cells[]` (`id`, `label`, 1–4 of them, row-major). Switches: `trend` (➚ = ➘ per line), `tag` («Stichwort» per line). |
| `map` | The Lagekarte: the live mini Karte on screen, a snapshot on paper | – |
| `table` | Rows × columns | `columns[]` (see below), `fixedRows[]` (`id`, `cells` = the pre-printed values of the fixed columns, `hidden`), `addRows` (default: yes unless fixed rows exist), `seed: "vehicles"` (pre-fills the first typed column with the vehicles the Einsatz knows), switch `done` (an «Erledigt» tick per row). |
| `text` | Free text fields (Konzept, Antrag …) | `fields[]` (`id`, `label`, `tone`, `type`), `layout`. |

**Table columns** have `id`, `label` and these optional keys:

| Key | Meaning |
|---|---|
| `type` | `text`, `time` (Wann), `trend`, `symbol` (a printed Signatur, see below) or `index` (a numbered disc). |
| `fixed` | The value is pre-printed by the row. |
| `w` | Relative width. |
| `hidden` | When true, the column is not shown. |

**Text fields**

- `tone` is `plus` / `minus` (the Variante's green and red boxes) or `shade` (a grey box for a
  given value).
- `type` is `text` or `time`.
- `layout` is `stack`, `row`, or `split` (the first field on top, the rest side by side under
  it).

**Signaturen** (`symbol` columns) are drawn as on the poster, in `BoardSignature.tsx` and
`report_board · draw_signature`. The poster's six are `patientensammelstelle`,
`sanitaetshilfsstelle`, `rettungsachse`, `standort-einsatzleitung`, `sammelstelle-unverletzte`
and `warteraum`. The two extras are `wasserbezug` and `absperrung`. A new key must be added to
both files.

### The switches in the FKS file

The bundled FKS file is strict 1:1, so every extra the staging «Erstes Plakat» had is a switch
that is **off** — except the trend ➚ = ➘ per problem, which the owner wants on (staging round 2;
`sections[problem].trend`, printed too). A station turns one on in its own copy:

| Switch | Where |
|---|---|
| Header line Einsatz · Adresse · Alarm · Einsatzleiter | `pages[ef].header: true` |
| «Stichwort» per problem | `sections[problem].tag: true` |
| «Erledigt» tick per Massnahme | `sections[massnahmen].done: true` |
| Wasserbezug / Absperrung in the Abspracherapport | `fixedRows[wasserbezug \| absperrung].hidden: false` |

## The bundled pages

| Page | Source | Layout |
|---|---|---|
| Erste Führung | FKS Plakat A3 V 1.0/10.09.2019 (DE/FR/IT) | 2 × 3 boxes, as the poster |
| 8.1 Problemerfassung | Handbuch p. 145 | landscape table: Problem/Ereignis · Entwicklungstendenz ➚ = ➘ · Notwendige Reaktion · Priorität |
| 8.6 Mittel | Handbuch p. 153 | table: Formation · Personal/Mittel · Auftrag/Wo · Wann, 23 rows |
| 8.8 Verbindungen | Handbuch p. 155 | table: Funktion/Standort/Name · Kanal · Rufname/Telefon-Nr. · Wann |
| 8.9 Konzept | Handbuch p. 156 | Auftrag · Eigene Mittel · Auflagen · Variante 1/2 (+ / –) · Antrag · Begründung |
| 8.11 Rapport | Handbuch p. 158 | the eight Traktanden + Wer, and Datum / Zeit of the next Rapport |

- The French and Italian words come from the FKS posters and the FR/IT editions of the Handbuch.
- The English is our own translation.
- One obvious typo in the official French text was corrected: «collectteur» → «collecteur».
