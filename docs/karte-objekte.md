# Karte & Objekte

Status: 🟡 in progress (from 2026-10-16). The station reads and the `/karte` viewer are built; the
home switch (Karte & Objekte as the start when no Einsatz is open), the «Einsätze» sheet, the
Einsatz-menu entry back to the viewer and deliberate offline downloads follow in their own changes.

«Karte & Objekte» is the station's reference viewer **outside an Einsatz**: a member looks at the
station area, an object's plans and notes, the register facts of any building, and starts an
Objektbesuch from there – without opening an Einsatz to get the data. It is read-only for
operational and station data, and it has its own view state: nothing it does moves, selects or
binds anything in an Einsatz.

## Who may read

Account sessions – `editor`, `el` and `viewer` alike – and the deployment-admin session. Every
incident link (alarm, view, Atemschutz, terminal) and the Erfassungs-Poster's capture token get
**403** (`backend/app/api/station_reference.py · get_station_reader`; the link allowlist does not
name these routes either). A link is scoped to one Einsatz and must never become a door onto the
station's register. Starting an Objektbesuch from the viewer stays governed by
`objectVisits.captureRoles` ([`object-visits.md`](object-visits.md)).

## `GET /api/reference/objects`

Every station object in one payload, which the client searches and keeps for offline:

```jsonc
{
  "objects": [{
    "id": "<uuid>", "name": "Schloss Musterdorf",
    "kind": "einsatzobjekt" | "objekt" | "depot",
    "address": "Schlossgasse 9", "locality": null,              // locality: the town, only when not the home town
    "lat": 47.52, "lng": 7.57,                                    // null when the station has none
    "outline": "auto" | "building" | "none",                      // the station's outline choice
    "aliases": ["Schlossgasse 9 - Wasserschloss"],
    "plans": [{ "id": "plan:<uuid>:modul23", "module": "modul23", "code": "2/3", "title": "…",
                "pages": 3 | null, "georef": true, "version": 2, "updatedAt": "…" }],
    "floors": [{ "index": -1, "name": null }, { "index": 0, "name": "Hauptebene" }],
    "egid": null, "footprint": { "type": "MultiPolygon", "coordinates": [ … ] } | null,
    "measures": "…", "remarks": "…", "measuresSource": "Modul 1 · Stand 03.2026", "updatedAt": "…",
    "lastVisit": { "id": "ov-…", "checklist": "Kontrolle Schlüsselhülse", "date": "…", "defects": 1 } | null
  }],
  "generatedAt": "…"
}
```

How each field is derived – none of them is a new column:

- **All objects**, including the plan-less ones an Objektbesuche organizer created (key boxes).
  The Einsatz pickers (`/api/objects`) leave those out on purpose; the viewer lists them.
- **`kind`**: `einsatzobjekt` when the object carries a Modul-PDF; `depot` when it carries none and
  its name says «Schlüssel…» (Schlüsseldepot, -hülse, -rohr) or an organizer ref comes from the
  key-box source (`fwo-schlue`); `objekt` otherwise. The map draws a `depot` as the FKS
  «GB Schluesseldepot» symbol.
- **`address`** — for every object where one is knowable (review round 2, 17.10.2026: three key
  boxes and three objects sent `null` and the viewer printed the kind word): the station's own
  address; else the NAME when it is a street + number («Mühlemattstrasse 24», «Bienenstrasse 28
  (EH)» → «Bienenstrasse 28»); else the register's (GWR) address at the pin, which the footprint
  job asks once per coordinate (`object_footprints · place_at`, never per view). `null` only when
  none of the three exists. **`locality`** is the town only when it is NOT the home town
  (`map.geocoder.defaultLocality`): the station's stored `objects.locality`, else the town of the
  register entry at the pin. The client prints «address, locality» («Erlenstrasse 60, Therwil»);
  the home town is never sent.
- **`outline`** — the station's choice in /admin («Lage korrigieren», below): `auto` = the rule
  under `footprint`; `building` = only the building at the pin; `none` = no outline at all — the
  viewer then draws NO OSM fallback either (`lib/karte/places · objectBuildings`).
- **`aliases`**: the plan library's folder name when it differs from the name and address.
- **`plans`**: the object's PDF datasets with bytes, by module. `code` is the module key without
  «modul» («23» → «2/3»). `pages` comes only from a tile manifest the server already wrote
  (`plan_tiles.stored_page_count`) – the listing never opens every PDF – so it is `null` when
  unknown. `georef` is true when the CURRENT revision has an approved fit that passes the same
  gate as `GET /api/reference/{id}/alignments` (`plan_floors.fit_publishable`).
- **`floors`**: the Geschosse of the current revisions' floor packs, by signed index; the words
  («EG», «1. OG») are the client's copy (`lib/whiteboard · floorLabel`), the station's own name wins.
- **`egid`**: no station source carries one today, so it is `null`.
- **`footprint`**: EVERY building the object stands for, as one MultiPolygon, the building its
  point lies in first (review 17.10.2026: Schulhaus Hüslimatt is five buildings on several parcels,
  and only one was red). Derived by the scheduler, never per request, from official data
  (`app/object_footprints`), and only read here:
  1. the object's point in an allowed swissTLM3D **use area** (school, college/university,
     hospital, sports ground, swimming pool, cemetery, zoo, substation — the `landuse` layer of
     swisstopo's base vector tiles, z14) → every building whose centroid lies in it;
  2. else its cadastral **parcel** (geo.admin identify, `ch.swisstopo-vd.amtliche-vermessung`) →
     every building on it;
  3. else the one building its point lies in.
  The buildings are the cadastral survey's own footprints (amtliche Vermessung, Bodenbedeckung
  «Gebäude», geodienste.ch's open AV WFS). A step is skipped when it is too big to be one object
  (area > 150 000 m², parcel > 60 000 m², more than 15 buildings — an estate of unrelated firms)
  or when it holds ANOTHER station object's point (key boxes aside): two catalogue objects on one
  parcel never claim each other's buildings. Sheds under 30 m² on the grounds are not the
  object's. `null` (nothing official at the point, not derived yet, a source switched off with
  `FOOTPRINT_AREA_TILES=` / `FOOTPRINT_BUILDINGS_WFS=`) → the viewer outlines the OSM building
  that CONTAINS the object's coordinate, as before. Never a building by proximity alone.
  What a source said is stored per coordinate (`reference/object-footprints.json` beside the
  building snapshot), so a moved or new object is asked once (≤ 20 points per two-minute tick),
  a catalogue change re-derives without asking anybody, and a failed ask is retried after an hour
  and never stored as «nothing there». A footprint is served only while the object still stands
  on the point it was derived for.
- **`lastVisit`**: the latest COMPLETED Objektbesuch (drafts and discarded visits are not visits
  that happened), only where the station runs the module or for the admin session.

## Where an object is, and how the station corrects it

An object's position comes from its import: the station's private importer and `admin_objects
load/push` write the manifest's `lat`/`lng`, the SharePoint pull geocodes the folder's address
when it creates an object, `admin_objects geocode-missing` / `repair-sharepoint-keys` fill the
ones without. ⚠️ **None of them may take a fuzzy match** (review round 2, 17.10.2026: ARA Birsig,
«Erlenstrasse 60» without its town — `geocode()` appended the home locality, swisstopo had no
Erlenstrasse in Oberwil and answered «Vorderbergstrasse 60, 4104 Oberwil», 1.1 km from the real
place in Therwil). They all go through `geocode.locate`: an EXACT street + number, inside the
region bias's bbox (`map.geocoder.bboxLv95` — the brigade's area, never a hard-coded town list),
the home town first; one match elsewhere in the area is taken (with its town), several towns and
none of them home is **ambiguous** — the object is left without a position and the census /
log names it for the station. A name that is no address finds nothing. The Einsatz's own
`geocode()` (an operator looking at the pin a moment later) is unchanged.

**«Lage korrigieren»** (Verwaltung › Objektpläne › an object › Lage; `admin/ObjectPositionSheet`):
an aerial (SWISSIMAGE) with the pin to tap or drag, the register search (`GET
/api/objects/position-search`, the area's exact matches first, home town first, the town said),
a «Dorthin» offer when the register puts the object's own address more than 60 m from its pin,
the outline the Karte draws today (dashed), and the outline choice (Automatisch / Nur Gebäude am
Punkt / Kein Umriss). `PUT /api/objects/{id}/position` (editors and the admin session only):

- marks the object `position_source = 'station'` — from then on `PUT /api/objects/{id}` (the
  manifest push), `admin_objects load`, the SharePoint pull and an organizer keep the station's
  `lat`/`lng`; the admin mask shows the coordinates read-only with the reason;
- a register pick also writes the address and the town (`objects.locality`, never the home town);
- appends `object_position_events` (before/after snapshot, who) — `GET …/position/history`;
  `POST …/position/undo` takes the LAST correction back, mark included (one step, then 409);
- the footprint job re-derives at the next tick (≤ 2 min): a new point is asked like any other,
  and the outline choice is part of the job's signature.

## `GET /api/reference/building?lat=&lng=[&address=][&lang=]`

The Gebäude card's `BuildingOut` ([`building-card.md`](building-card.md)) for any point, without
an incident: the same register lookup and cache (`api/building · fill_registers` →
`building_facts.registers_cached`), the same `registers` / `gwr_status` / `pv_status` states, the
same source and date fields for «Register-Hinweis».

`object` is set **only on an exact street + number match**: the register's address of the building
found (or, when the register has none, the searched `address`) equals a catalogue object's. Two
objects at one door (an Einsatzobjekt and its key box) → the one with plans. A neighbour ten metres
away is never «the building», because its gas valve would read exactly like this one's. `visit` follows
the object, under the same module rule as `lastVisit`.

⚠️ Both routes live on their own router, mounted before `api/reference`: that router's
`/{dataset_id}` would otherwise answer `/reference/objects` as a dataset called «objects».

## The viewer (`/karte`)

`src/components/karte/` — its own lazy chunk, mounted by `App` for the `/karte` route (deep link:
`/karte?objekt=<id>` selects an object; the address follows the selection without a history
entry). It is the app's home with no Einsatz open (below), and over an open one it is reached from
the Einsatz menu's «Einsatz verlassen»; a deep link at start opens no Einsatz behind it (the same rule as `/besuche`).
Not for a link session.

What it reuses, so nothing forks:

| Piece | Reused from |
|---|---|
| map, layers, vehicles, measure path, georef raster, weather radar | `MapView` (read-only, no drawings) + `MapLayers` (a `polygons` overlay kind draws the outlines) |
| Ebenen | `LayerPanel`, under its OWN device key (`kp.layers.karte`, `lib/karte/session`), without the Einsatz-only layers (taktisch, Skizzen, Personen); the radar's choice too (`kp.karte.radar`) |
| tools | the Einsatz's `ToolRail` (tablet) / the folded `navrail` bar (phone: Karte · Messen · Gefahrgut · Ebenen), `ToolDock` + `MeasurePanel` WITHOUT «Als Linie/Fläche übernehmen» (and without a line saying it is not saved — nothing here is), stacked on the phone like an Einsatz's: dock 6px above the bar, readout 6px above the dock, one bar lower because the Karte has no tool bar, `MapViewsButton` without saved views |
| weather | `useWeather` + `WeatherBadge` |
| plans | the NavRail classes and `PlanGlyph` (tablet rail), rows in the object's panel; a module opens in the Einsatz's plan reader — the Plan surface's `Whiteboard`, read-only, on the current revision (below); the Gebäude storeys as the floor pack's page regions (`planRegionCropUrl`, what `FloorPage` draws from) |
| plan titles | the module catalogue the Einsatz's plan chooser labels its tiles from (`lib/planOrder · moduleCatalogue`), through `lib/karte/plans · planTitle` (below) |
| the phone sheet | Ebenen's own: `.layers-card`, `overlays/SheetGrab`, `overlays/useSwipeDismiss` |
| register facts | `lib/buildingCard` (chips, source line), the same «Register-Hinweis» |
| Gefahrgut | `UnHazardSection` — the Gefahrentafel's ADR/ERG block, extracted from `ContextPanel` |
| building outlines | the object's own `footprint` (above); for every other building and an object without one, the Umriss picker's `/api/overpass/buildings` (station snapshot first), loaded per grid cell (`lib/karte/outlines`) |

The rules that are easy to break:

- **Own state, never an Einsatz's.** No workspace, no saved drawing, no plan binding, no journal
  row. Measurements, the Gefahrgut rings and a dropped pin are component state; only the Ebenen and
  the view (`KarteView`: frame, selected object, open plan, in sessionStorage) are kept —
  `karteViewSnapshot` is the one door into storage (`lib/karte/karte.test.ts` pins it).
- **A building is an object only by official data, containment or an exact address.** An object
  is drawn as its `footprint` (every building of its use area / parcel, above), else as the OSM
  outline that CONTAINS its own coordinate (`lib/karte/places · objectBuildings`); a tap on ANY of
  its buildings opens it, the selected object's buildings all wear the strong style, and its tag
  hangs off the building its point lies in. A tapped building opens an object otherwise only when
  the register's street + number equals the object's. A key box at the same door is not the
  building. No outline under a point → no building.
- **A tag never hangs on another object's building** (review round 2, 17.10.2026 — Migros at
  Mühlemattstrasse 18 and the Mühlemattcenter at 22 share a roofed passage; the «Migros» tag hung
  under its building, i.e. on the Mühlemattcenter's roof beside its «22», while the OSM base map
  writes «Mühlematt Center» on the Migros building: the two read as one, swapped). The tag hangs
  under its building unless that spot lies on another object's outline; then it sits inside its
  own building (`lib/karte/tagAnchor`).
- **Dots, and a name only where it fits** (owner, 17.10.2026; `lib/karte/labels`). Below z16 every
  object is a small red dot (a 32 px tap target), a key box a small FKS glyph; no text. From z16
  on a tag only where it fits: one greedy pass in screen space once the map has settled, the
  selected object first (always tagged), then Einsatzobjekte, then more plans; a tag that would
  cover another tag, a key box or the chrome (top bar, bottom bar, an open panel or sheet, the
  rails — every child of the surface but the map) stays a dot. A tag at a side edge slides inward
  as long as it still hangs over its building. Outlines draw from z15 as before.
- **«In der Nähe» is distance only**, and the panel says so in a sentence.
- **The panel, in one order** (owner, 17.10.2026 · review round 2), the same for an object on
  the phone and on the tablet: head (kind, name, address, ✕) · the station's word
  (Sofortmassnahmen, then Bemerkungen, with their source — what matters most in a hurry) ·
  Pläne & Module as rows (code, title, pages, offline the «auf diesem Gerät» mark) · Gebäude laut
  Register · In der Nähe · Objektbesuche · the closing «Keine Gefahrenangaben …» · the actions
  LAST, «Objektbesuch» and «Melden». A plain building or a dropped pin keeps that order with what
  it has (Register, In der Nähe, Melden; a pin also «Koordinaten kopieren»), a key box too (no
  Register, its note one quiet line). No «Messen ab hier» (Messen is the bar's / the rail's) and no
  «Objektplan auf der Karte» row: the aligned plan is switched in Ebenen (`Pläne` group, the
  viewer's `karte:objektplan` twin), which keeps the capability. Section titles are the sheet's
  group heads (eyebrow, no glyph); a missing or quiet fact is a line, not a box — only a warning
  (no coordinates, the register unreachable) keeps its box.
- **On a phone the panel is the Ebenen sheet** (owner, 17.10.2026 · R2: «a full slide-up like for
  "ebenen" and not this half thing»). `KartePanel` wears `.layers-card` there, so it IS that sheet:
  flush with the bottom edge and both sides, over the bar, the hero corner, hugging its content up
  to Ebenen's cap, the grab bar on top, pushed down to close (`useSwipeDismiss`; the head is the
  handle, a scrolled body scrolls), the toasts moved out of its way like for Ebenen. One height,
  no peek. It sits over the bar but under the top bar (`--z-chrome-raised`), so «Einsätze» and the
  search still open over it. ✕ or a push down closes the SHEET only: the place stays selected —
  outline, tag, pin, `?objekt=` — and a tap on it again brings the sheet back; a tap on empty map
  deselects. A place selected on a phone is framed in the strip above the sheet (the deep link's
  first frame too). The tablet keeps the left panel, its rail and ✕ = deselect.
- **A plan opens in the Einsatz's plan reader, read-only** (owner R2: «the normal pdf viewer we
  have just without the annotation»). `KartePlans · KartePlanBoard` mounts the Plan surface's own
  `Whiteboard` (the lazy chunk, `workspace/lazySurfaces`) on the plan's current revision: the page,
  pan/zoom and the floating ± / Einpassen a locked device reads a plan with — and for a module the
  catalogue marks `viewer` (Modul 6, PV) the same scrolling reader the Einsatz opens there. It is
  handed no Einsatz: `readOnly` (no tools, editors or floor controls), `slimTools` off (no Auswahl
  on an empty sheet), `linkViewer` (no Maßstab / Passung chips — no door to a calibration or to
  «Karte verknüpfen»), no annotations, and every writer a no-op (`onChange`, `log`, `emit`, the
  history); no `incidentId`, `onCalibrate` or `onObjectSwitch`. Its bottom-left row is hidden: the
  Karte's chip row («Zur Karte» on the phone, the object's name on the tablet) is the way back,
  and so is the bar's Karte tab. No «Auf der Karte» beside it (owner, review round 3,
  17.10.2026: struck as not needed — the aligned plan stays switchable in Ebenen). `KarteApp.test`
  pins what is handed in. The Gebäude stack stays the Karte's own storey list (an Einsatz's
  Gebäude needs an incident's building pick).
- **The plan says when it is still sharpening** (owner, review round 3: «if you zoom in quickly
  before things have loaded, everything is blurry … we're obviously not fully offline like with a
  normal incident»). In an Einsatz the tiles are on the device ahead of time; here they come over
  the network on demand, and the soft underlay looks the same whether the detail is on its way or
  will never come. `KartePlanBoard` provides `lib/planSharpness · PlanSharpnessContext`, and the
  reader reports the CURRENT view: `PlanTileLayer` from its pending/failed detail tiles (quiet while
  the underlay itself is cold — the reader's own «PDF wird geladen …» speaks then), the pdf.js path
  from a preview standing in for the full bake or a deep-zoom refine pass not yet landed. The chip
  stands top centre under the bar, never takes a tap, and shows only after 300 ms of «not sharp»
  (a quick load never flashes): «Schärfere Ansicht wird geladen …» with the Shell trail, «Schärfere
  Ansicht nur mit Netz» when a tile could not be had offline, «Schärfere Ansicht konnte nicht
  geladen werden» online. Once the view is sharp and the device online, the reader fetches the
  tiles a 2× zoom of the SAME area would ask for (at most 48, low priority, each once — never a
  whole plan), so a quick zoom is sharp sooner; the service worker keeps them (`plan-tiles`). The
  Einsatz's Plan surface provides no context: no chip, no fetching ahead there.
- **A pin is set with the ⊙ tool and a tap — nothing else** (owner, review round 3: «I can't
  delete nodes when measuring because it wants to create a point»). A long press anywhere used to
  drop one too, and it fired under a held measure node — the hold that removes the node
  (`MapView · vertexPress`) — dropping a pin and leaving Messen. The surface has no long-press
  handler now, on the phone or the tablet; `KarteApp.test` holds a node and checks.
- **Plan titles** (`lib/karte/plans · planTitle`): many sheets in the real catalogue are titled by
  their file name, «<object> – <module key>» («Migros – modul2», «Sägestrasse 8 - Schulhaus
  Hüslimatt – modul2-3»). Such a title gives way to the catalogue's title for the key («Wie komme
  ich herein», «Zugang & Objekt», «Photovoltaik»); a clean title («Übersicht», «Gemeindehaus –
  Übersicht») stays. A family sub-slot without an entry says its own name («Wasser»), a numbered
  sibling keeps its number («Wasser 2»), an unknown key reads «Modul N». The panel's rows, the
  tablet rail's labels and the view label all read the document's title.
- **A head that is still being looked up is a skeleton**, never «Gebäude» or «…» in place of a
  name: a tapped building until the register answers (a searched address is named at once), a
  dropped pin until its address is known. A plain building carries no «Kein Stationsobjekt …»
  box — the kicker says «Gebäude», the line under the name says «Kein Stationsobjekt» once known,
  and the closing «Keine Gefahrenangaben …» sentence still stands.
- **Missing is said.** A register that could not be asked, a place never looked at offline, an
  object without notes: each gets its sentence, and «Keine Gefahrenangaben … heisst nicht …»
  closes the panel. Nothing reads as «no hazard».
- **Doors by role.** «Objektbesuch» / «Melden» only for `objectVisits.captureRoles`
  (and only where the module runs); every other account reads the visits with a one-line reason.
- **Search** finds objects on the device first — name, address, aliases, folded umlauts, every
  word of the query — ranked name before alias/address, plans before none, key boxes last, then
  distance (`lib/karte/search`). Objects without coordinates are found and marked «ungefähr»
  (their place on the map comes from geocoding the address). Addresses follow from
  `/api/geocode/search`, online only, and say so offline. A row is glyph · name · address
  (· distance for a hit) — no plan count (owner, review round 2, 17.10.2026: «just the address is
  enough»; the sheet lists the plans, the map tag keeps its count).
- **The address, never the kind word in its place** (review round 2). Key boxes and plain objects
  are often named by their address with none stored; an object's address is the stored one, else
  its name when the name is street + number, else none (`lib/karte/places · objectAddress`). A
  name that already says it is printed once, as the title: a list row then reads «<place> ·
  <kind>» under it (`objectRowSub`), the head only the place (`objectHeadSub` — its kicker says
  the kind). An object with no address at all is described by its kind in a list.
- **Ebenen: «Alle ein» / «Alle aus» / «Standard»** (review round 2), the Einsatz's three chips
  over the viewer's own layers (`lib/karte/layerPresets`). «Standard» is the deployment's default
  set as the viewer opens with no device choice, the Basiskarte included; «Alle» / «Keine» switch
  every overlay, never the Basiskarte. The viewer's station rows (Stationsobjekte, category rows)
  are layers here: on in «Standard», switched by both chips — whatever rows the panel lists, none
  is named in the code. The aligned plan on the map is not (a plan backdrop is switched on on
  purpose, and the Einsatz's chips leave plan rasters alone too). The radar: off with «Standard»
  and «Alle aus», left by «Alle ein», no chip lit while it is on. Transparencies stay.
- **The keyboard on a phone** (review round 2, owner-r2-keyboard). iOS lays the keyboard over the
  page and pans it to show the caret; the viewer publishes the visible band like an Einsatz
  (`lib/useViewportPan`: `--vv-pan`, `--vv-foot`, `html[data-kb]`), so the bars stay on the screen,
  the bottom bar steps aside, the Gefahrgut card fills the band from under the top bar down to the
  keys with its UN field at the top (outside the readout's scroller), and the search results end
  on the keys. Playwright raises no iOS keyboard: the shots simulate one (a visualViewport shrunk
  and panned by the keyboard's height, as the owner's screenshot shows iOS doing); the real
  iPhone is the check.
- **Hints use the width they need** (review round 2): «Auf die Karte tippen …» is one pill as wide
  as the bottom bar on a phone (max-content up to 640 px on a tablet), one or two lines; the
  Gefahrgut card says where its rings stand first, right under the UN field.
- **Visits hand over** to the existing capture: `/besuche/neu?object=<id>&from=karte` for an
  object, `/besuche/neu?lat=&lng=&label=[&address=]&from=karte` for a building or a pin (contract
  C1, label «bei <Adresse>» within 60 m of a pin, else «Gesetzter Punkt»). **«Melden»** (something
  is wrong or missing here: hydrant, access, key box, plan …) is the same hand-over with
  `&checkliste=fehlermeldung` (`lib/karte/places · REPORT_CHECKLIST`): the new-visit screen takes
  the station's «Fehlermeldung» checklist when the catalogue has it — station data
  (kp-front-data), never bundled — and falls back to its chooser when not; a reload resumes an
  open Fehlermeldung draft, never an unrelated draft at the same object
  (`objectVisits/store · findOpenDraft`). An existing visit opens
  at `/besuche/<id>?from=karte`. The viewer stays «entered» while that visit is open, and a visit
  opened from it has no Übersicht behind it: its «Zurück» (to its work list or the Übersicht)
  lands on the viewer's own address again — read views and reports included (`App` · `ovReturn`).
- **Alarms** reach the viewer through the Meldeleiste and the same two banners as the
  Objektbesuche; nothing switches by itself. A running Einsatz is the red chip in the bar (a strip
  under it on a phone); a tap opens it.

## Object colours (`map.objectCategories`)

Owner, 17.10.2026: colour the objects so that key boxes / plans, water plans, PV systems … are
told apart. The station sets ordered rules in the deployment config (Verwaltung › Station &
Karte › «Objektfarben», schema `ObjectCategoryConfig`), FIRST match wins:
`{ id, label: "…" | { de, fr, it, en }, color: "#rrggbb", match: { kinds?: [einsatzobjekt|objekt|depot], modules?: [glob…] } }`.
A rule matches when every condition it names holds (none named = catch-all); `modules` globs
match the object's plan modules (`modul5-pv*` = `modul5-pv`, `-pv15`, `-pv20`). An object no rule
takes keeps the default look: red, a key box its FKS glyph. No rules = today's map.

- The map draws the object's dot, tag rim + count and outline (normal and selected) in the
  category's colour (`lib/karte/categories`; ink on the count by luminance). A key box keeps its
  FKS glyph, with a ring in the colour among the dots.
- **Ebenen** has one row per rule under «Station» (glyph in the colour, «n Objekte»): off takes
  that category's objects off the map — outline, dot, tag and tap; the selected object stays. A
  device preference like the objects row (not kept across reloads).
- Pick colours that stay apart for the colour-blind (no red against green) and that read on the
  light, dark and aerial base maps.

## Offline

The viewer never downloads anything on its own for offline use; it READS what the device already
holds and says so (`src/lib/karte/availability.ts` decides, `components/karte/useKarteOffline.ts`
and `KarteDevice.tsx` probe). No «ganze Station herunterladen»: that would be several GB (owner,
16.10.2026); deliberate downloads of chosen objects or areas come later.

| What | Where it is kept | Filled by |
|---|---|---|
| object catalogue | IndexedDB `kp-front-station-objects` (one entry) | every online open of `/karte` |
| register facts of a building | IndexedDB `kp-front-station-building:<where>`, the last 300 kept (index `kp-front-station-building-index`) | every building / object looked at online |
| plan PDF | the service worker's `reference-plans` cache, per revision URL | opening the plan once online |
| Gebäude storeys, aligned plan | that PDF + the revision's alignment metadata (IndexedDB, `lib/api/reference`) | opening Gebäude / the aligned plan once online |
| base map | the service worker's `map-tiles` cache | looking at the area, or an Einsatz's Offline-Vorbereitung |
| Gefahrgut (UN/ADR) | bundled with the app | — |

What the surface shows offline:

- **The bar's «Offline» chip** (a dot only on the phone) stands where the weather was and opens
  **«Auf diesem Gerät»**: Objektkatalog · Karte (this view) · Pläne (PDFs of the whole catalogue) ·
  Gebäuderegister · Gefahrgut · Adresssuche · Wetter/Fahrzeuge · Gerätespeicher, each with ● on
  this device / ◐ partly / ○ only online AND the same in words. The Gebäuderegister is never ●: only
  buildings already looked at are stored.
- **Pläne & Module** rows carry ●/○; a plan the device does not hold is dimmed and says «Nicht auf
  diesem Gerät gespeichert», but stays tappable – the surface then says the PDF is not stored
  instead of a reader spinning on a dead fetch. The tablet rail dims the same tiles. Gebäude is ●
  only when every revision's alignment metadata and every storey's PDF are stored, ◐ when some
  storeys are (the stack then says some are missing). «Objektplan auf der Karte» is offered offline
  only when the aligned plan's PDF and metadata are both stored.
- **The base map:** where the device holds neither a tile nor a parent MapLibre could scale up (4
  levels), the viewer HATCHES the tile (a `polygons` overlay with `hatch`, the Schraffur pattern),
  so a blank area reads as «no map stored» and objects stay on top. Probed only while offline or
  while «Auf diesem Gerät» is open, 300 ms after the map settles, at most 96 tiles a view. The
  first base tile that fails offline also raises the Einsatz's «Keine Basiskarte» Meldung
  (`NoBasemapMeldung`, here with its action «Verfügbarkeit»), once per visit, withdrawn when the
  link is back.
- **A base map in two looks is a stale cache, not two maps** (the «seam», review 17.10.2026). The
  `map-tiles` cache is cache-first for 30 days under the tile's URL; when a provider re-renders
  under the same URL (CARTO's GL-rendered Dark Matter, autumn 2026: buildings now LIGHTER than the
  ground, blue-grey roads), a device shows old tiles where it holds them and new ones elsewhere,
  with a sharp edge at the tile border. `lib/tilePurge` names each such change and deletes its
  tiles once per device, on the first boot ONLINE (offline the old look beats no map); a miss is
  fetched past the HTTP cache (`fetchOptions: { cache: 'no-cache' }`, vite.config) so CARTO's
  `immutable` answer cannot bring the old tile straight back. A provider changes its look again →
  add a purge entry.
- **Search:** station objects are found on the device; the address search says it needs the
  network. **Objektbesuche** say they need the network and name the catalogue's last visit.
- The catalogue shown from the device is replaced by the server's as soon as it answers again
  (`lib/connectivity · onReachable`, the `online` event), without touching the selection.

⚠️ «●» only for what a probe actually FOUND. Without a service worker controlling the page (a dev
server, a first visit) nothing is served from Cache Storage once the network is gone, so every
cache-backed row reads «nur online» – never a guess. A failed IndexedDB read is not «held» either.

## Home (owner, 16.10.2026 · variant B)

With no Einsatz open, an **account** lands on the viewer at `/` instead of the old launcher card.
`lib/karte/home` holds the decision and its tests:

- **`bootPlan`** names what a list boot does, in the order it always did: a launch into a surface
  (`/besuche…`, `/karte…`) opens nothing behind it; else `pickBootIncident` (a fresh alarm-created
  Einsatz under 3 h, the remembered one, the first open one, the stay after an Abschluss, the
  crash-loop skip) and the closed-return (`shouldReopenClosed`) — **unchanged**; only «nothing to
  resume» is new: home. «Einsatz abschliessen» and «Zurück» from a closed Einsatz land there too.
- **`appScreen`** picks the screen: the Objektbesuche surface, the viewer, the boot's splash, an
  Einsatz — and the launcher card only for a **link session** whose Einsatz could not be fetched
  (it has no station to look at). A visitor who is not signed in still gets the login screen.
- **«Einsätze ▾»** (top left of the bar) opens **the same menu as inside an Einsatz** (owner,
  17.10.2026 — it was the old launcher card with big launch buttons): one component,
  `panels/AppMenuRows`, renders the rows under the Einsatz menu's card (`IncidentSwitcher`) and the
  whole of this sheet, so the two cannot drift. Here it has no card (no Einsatz is being worked
  on): the «Einsätze» label, the running Einsätze as rows (laufende Zeit · title · short address —
  the one the viewer covers too, whose row only steps the viewer aside), the alarms waiting to be
  taken (bell · «Neuer Alarm» · title · address · «Öffnen», and the × that hides one on this
  device only — both locked while a take runs), «Alle Einsätze», «Einsatz eröffnen» (editors);
  then «App»: Objektbesuche, Einstellungen, **«Auf diesem Gerät»** (the viewer's own availability
  sheet, in the slot the Einsatz menu gives «Offline-Bereitschaft», which is about an open
  Einsatz), Funktionen & Hilfe, Installieren where offered; who is signed in with Abmelden, the
  build label. With nothing running and nothing to take, one quiet line says «Keine offenen
  Einsätze». The Rückmeldung prompt (`trouble`) heads the sheet. `App · homeMenu` hands in the
  handlers; the viewer only opens and closes the sheet (`einsaetze.render(close, onDevice)`). The
  badge is running Einsätze + alarms waiting to be taken. The old card (`App · launcherBody`) is
  left only for a link session whose Einsatz could not be fetched.
- **Alarms** show in the Meldeleiste and the banner (no «Anhängen»: no Einsatz is being worked on
  screen); nothing switches by itself. Taking one keeps the 12 s «Alarm übernommen · Rückgängig»,
  and the undo returns to the viewer, not into another open Einsatz.
- **From an Einsatz:** **«Einsatz verlassen»** (owner, 17.10.2026; it was «Karte & Objekte» in the
  «App» group) — about this Einsatz, so in the Einsätze group as the first action under the
  running rows, above «Alle Einsätze», with the map glyph (never the Abmelden one). «verlassen» must
  not read as closing, so the sub line says the Einsatz runs on: «Läuft weiter · zurück zu
  <Objekt · Modul>» when this device has a viewer state, else «Läuft weiter · zur Karte». Never
  for a link session (no `onOpenKarte`). It replaces the address with `/karte` (no history entry — the operational
  screens have none, `objectVisits/route`), and the viewer says «Wieder bei …» once. The way
  back is the red chip or the sheet's row, which only step the viewer aside; opening ANOTHER
  Einsatz leaves the viewer in the same step.
- **⚠️ The Einsatz behind stays alive — its Atemschutz alarm above all** (lead decision,
  16.10.2026: silence on a breathing-apparatus timer is the one failure we can't have at 3am).
  `IncidentWorkspace` stays MOUNTED with `covered` while the viewer — or the Objektbesuche, which
  had the same hole — is in front: every hook keeps running (sync, live poll, Verlauf, mute), it
  renders no map, plan or bars and listens to no keys, and it keeps exactly two things on: the
  alarm host (the same tone, and the OS notification with its sound and vibration) and the alarm
  rows in the Meldeleiste over the surface in front — overdue / Alarmdruck / Rückzug per Trupp,
  and the Notfall. «Zum Trupp» brings the Einsatz back (`App · uncoverEinsatz`, nothing reopens)
  on the Atemschutz board at that card. Pinned by `IncidentWorkspace.harness.test.tsx` · (k).
- **The viewer state** (`KarteView` in sessionStorage: frame, object, open plan / Gebäude, the open
  tool by name only, and the label for «Zurück zu …») is per device and per tab session. It is
  written only after the catalogue has answered, so an early exit cannot blank it, and it never
  touches the Einsatz.
