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
    "kind": "einsatzobjekt" | "objekt",
    "address": "Schlossgasse 9", "locality": null,              // locality: the town, only when not the home town
    "lat": 47.52, "lng": 7.57,                                    // null when the station has none
    "outline": "auto" | "building" | "none",                      // the station's outline choice
    "aliases": ["Schlossgasse 9 - Wasserschloss"],
    "plans": [{ "id": "plan:<uuid>:modul23", "module": "modul23", "code": "2/3", "title": "…",
                "pages": 3 | null, "georef": true, "version": 2, "updatedAt": "…" }],
    "floors": [{ "index": -1, "name": null }, { "index": 0, "name": "Hauptebene" }],
    "egid": null, "footprint": { "type": "MultiPolygon", "coordinates": [ … ] } | null,
    "underground": { "type": "MultiPolygon", … } | null,          // a named row's garages/shelters, drawn dashed
    "measures": "…", "remarks": "…", "measuresSource": "Modul 1 · Stand 03.2026", "updatedAt": "…",
    "lastVisit": { "id": "ov-…", "checklist": "Kontrolle Schlüsselhülse", "date": "…", "defects": 1 } | null
  }],
  "generatedAt": "…"
}
```

How each field is derived – none of them is a new column:

- **All objects**, including the plan-less ones an Objektbesuche organizer created (the stops of
  its Kontrollgang). The Einsatz pickers (`/api/objects`) leave those out on purpose; the viewer
  lists them.
- **`kind`**: `einsatzobjekt` when the object carries a Modul-PDF, `objekt` otherwise.
  ⚠️ **There is no `depot` (key box) any more** (owner, review round 3, 17.10.2026: «Mühlematt-
  strasse 24 doesn't have a key box … I think we can just highlight buildings / building groups»).
  It was guessed from a `fwo-schlue` ref or «Schlüssel…» in the name — but that ref only says the
  object is on the organizer's yearly Kontrollgang (FWO Admin's FU tours of 2026 carry a SchlüHü
  id for their stops, Einsatzobjekte with plans among them). Every object is a building or a group of
  buildings now, drawn like every other. The API never sends `depot`; a client reads an older
  server's or an older cached catalogue's `depot` as `objekt` (`lib/api/stationReference ·
  withRetiredKinds`).
- **`address`** — for every object where one is knowable (review round 2, 17.10.2026: six plan-less
  objects sent `null` and the viewer printed the kind word): the station's own
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
- **`aliases`**: the plan library's folder name when it differs from the name and address, and
  the names of objects merged into this one (`admin_objects merge`, docs/AGENT-RUNBOOK.md).
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
  (`app/object_footprints`), for every object, and only read here — first match wins:
  1. **the addresses in its NAME** (review round 3, 17.10.2026 — owner: «outline all the
     houses»): an object named by a row of houses («Stallenmattstrasse 2-14, Kaibmattweg 1-5
     (EH)», «Hohestrasse 136-158», «Auf der Wacht 14&16») is every building of every address the
     name covers. `app/address_ranges` reads the name and the plan folder alias («<address> -
     <name>»): street + numbers, ranges («2-14»), lists («14&16», «2, 4»), letters («128a-b»,
     «134f»). It counts only when the name holds a range or a list — «Sägestrasse 9» or «Hof
     Thürkauf, Im Buech 15, Im Buech 20» are left to the steps below. A number covers its
     lettered siblings (14 → 14, 14a) and a range the numbers in it that EXIST — **one side of
     the street when both ends have one parity** (owner, round 3: «you can assume that it's only
     the same side»: 136-158 → the even numbers, 27-29 → 27, 27a, 29), both sides when they differ
     (1-16). The register is the cadastral survey's
     Gebäudeadressen (`ms:HADR` on the same AV WFS) on those streets within 600 m of the point,
     in the town of the one nearest the point; each address's building is the survey footprint
     with its EGID, else the footprint its door point lies in. An address with no surface
     building is, in the survey, mostly an underground garage («(EH)» = Einstellhalle) or a
     shelter: its Einzelobjekt (`ms:SOSF`, «unterirdisches Gebäude» / «Unterstand», same open AV
     WFS) is served apart as **`underground`** and the viewer draws it as a DASHED outline in the
     object's colour — part of the object, tappable (owner, round 3: «if the garages are …
     accessible … in the default maps that we are using, it would be cool»; the station's Modul 1
     shows them too). Used when it finds at least one surface building and at most 60
     (`MAX_RANGE_BUILDINGS`, counting houses, not garages; more is logged — a name read wrong). No
     neighbour guard: the name is the station's own word for which houses the object is;
  2. the object's point in an allowed swissTLM3D **use area** (school, college/university,
     hospital, sports ground, swimming pool, cemetery, zoo, substation — the `landuse` layer of
     swisstopo's base vector tiles, z14) → every building whose centroid lies in it;
  3. else its cadastral **parcel** (geo.admin identify, `ch.swisstopo-vd.amtliche-vermessung`) →
     every building on it;
  4. else the one building its point lies in.
  The buildings are the cadastral survey's own footprints (amtliche Vermessung, Bodenbedeckung
  «Gebäude», geodienste.ch's open AV WFS, served in WGS84 — measured 17.10.2026 against swisstopo
  REFRAME on the LV95 originals: ≤ 1.3 cm). Steps 2 and 3 are skipped when too big to be one object
  (area > 150 000 m², parcel > 60 000 m², more than 15 buildings — an estate of unrelated firms)
  or when they hold ANOTHER station object's point: two catalogue objects on one parcel never
  claim each other's buildings (why «Stallenmattstrasse 1-14 …» and its near-duplicate «2-14 …»,
  points 55 m apart on one 8 100 m² parcel and in no building, had no outline before step 1). Sheds under 30 m² on the grounds are not the
  object's. `null` (nothing official at the point, not derived yet, a source switched off with
  `FOOTPRINT_AREA_TILES=` / `FOOTPRINT_BUILDINGS_WFS=`) → the viewer outlines the OSM building
  that CONTAINS the object's coordinate, as before. Never a building by proximity alone.
  What a source said is stored per coordinate (`reference/object-footprints.json` beside the
  building snapshot), so a moved or new object is asked once (≤ 20 points per two-minute tick),
  a catalogue change re-derives without asking anybody, and a failed ask is retried after an hour
  and never stored as «nothing there». A name's addresses are stored the same way, per point and
  per what the name says (`ranges`), so a renamed object is asked again and nothing else is. A footprint is served only while the object still stands
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
objects at one door → the one with plans. A neighbour ten metres
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
| plans | the NavRail classes and `PlanGlyph` (tablet rail), rows in the object's panel; a module opens in the Einsatz's plan reader — the Plan surface's `Whiteboard`, read-only, on the current revision (below); the Gebäude is the same `Whiteboard` on the Einsatz's floor stack (`lib/floorPackBinding · floorPackOf` / `packBuildingDoc`, below) |
| plan titles | the module catalogue the Einsatz's plan chooser labels its tiles from (`lib/planOrder · moduleCatalogue`), through `lib/karte/plans · planTitle` (below) |
| the phone sheet | Ebenen's own: `.layers-card`, `overlays/SheetGrab`, `overlays/useSwipeDismiss` |
| register facts | `lib/buildingCard` (chips, source line); «Register-Hinweis» folds the hint and the source line (below) |
| Gefahrgut | `UnHazardSection` — the Gefahrentafel's ADR/ERG block, extracted from `ContextPanel` |
| building outlines | the object's own `footprint` (above); for every other building and an object without one, the Umriss picker's `/api/overpass/buildings` (station snapshot first), loaded per grid cell (`lib/karte/outlines`) |

The rules that are easy to break:

- **Own state, never an Einsatz's.** No workspace, no saved drawing, no plan binding, no journal
  row. Measurements, the Gefahrgut rings and a dropped pin are component state; only the Ebenen and
  the view (`KarteView`: frame, selected object, open plan, in sessionStorage) are kept —
  `karteViewSnapshot` is the one door into storage (`lib/karte/karte.test.ts` pins it).
- **A building is an object only by official data, containment or an exact address.** An object
  is drawn as its `footprint` (the buildings its name, use area or parcel give, above), else as
  the OSM outline that CONTAINS its own coordinate (`lib/karte/places · objectBuildings`); a tap
  on ANY of its buildings opens it (a building two objects claim — a named row and a house of it
  that is an object of its own — opens the one whose point stands in it), and the selected
  object's buildings all wear the strong style. A tapped building opens an object otherwise only
  when the register's street + number equals the object's. No outline under a point → no
  building.
- ⚠️ **The tag sits ON the object's point** (owner, review round 3, 17.10.2026: «do not move the
  location of the marker»). Centred on the coordinate the station set, exactly where the dot is;
  the placement pass decides only WHETHER it shows, and a tag at a side edge slides inward at most
  until 16 px of it still cover the point. Round 1 hung the tag under its building's south edge,
  round 2 moved it inside its own building when that spot was another object's — both put the
  name somewhere the point is not, and that read as a moved marker.
- **A tag is the name, never a plan count** (owner, round 3: «we just care that there are
  plans»). Whether an object has plans is its colour: the station's category (below), or, with
  no categories configured, the default look — red rim and dot with plans, an ink-grey rim and
  dot without (`Karte.module.css · .bare`). No count on any tag or row; the sheet's plan rows are
  the only list of plans.
- **Dots, and a name only where it fits** (owner, 17.10.2026; `lib/karte/labels`). Below z16 every
  object is a small dot (a 32 px tap target); no text. From z16 on a tag only where it fits: one
  greedy pass in screen space once the map has settled, the selected object first (always
  tagged), then Einsatzobjekte, then more plans; a tag that would cover another tag or the chrome
  (top bar, bottom bar, an open panel or sheet, the rails — every child of the surface but the
  map) stays a dot. Outlines draw from z15 as before.
- **No key boxes on the map** (owner, round 3): no FKS «Schlüsseldepot» symbol, kicker, note or
  mark. The objects once drawn that way are objects like any other — outline, dot, tag, colour.
- **«In der Nähe» is distance only**, and the panel says so in a sentence.
- **The panel, in one order** (owner, 17.10.2026 · review round 2), the same for an object on
  the phone and on the tablet: head (kind, name, address, ✕) · the station's word
  (Sofortmassnahmen, then Bemerkungen, with their source — what matters most in a hurry) ·
  Pläne & Module as rows (the module only, offline the «auf diesem Gerät» mark — below) · Gebäude
  laut Register · In der Nähe · Objektbesuche · the closing «Keine Gefahrenangaben …» · the actions
  LAST, «Objektbesuch» and «Melden». A plain building or a dropped pin keeps that order with what
  it has (Register, In der Nähe, Melden; a pin also «Koordinaten kopieren»), a plan-less object
  too (no plan rows). No «Messen ab hier» (Messen is the bar's / the rail's) and no
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
  pins what is handed in.
- ⚠️ **The plan lies out exactly like an Einsatz's** (owner, review round 4, 17.10.2026: «use the
  same display like we have for our plans normally -> not this clipping here»). The reader keeps
  the box of an Einsatz's plan with no tool bar under it — on a phone ending 18px above the one
  bar, on a tablet the whole surface — and its own fit (`lib/whiteboard · containFit` with
  `chipRowInset`) keeps the floating row free; the Karte's chip row stands exactly where the
  reader's own `.wb-botleft` would (8px above the bar on a phone, 16px off the foot beside the rail
  on a tablet). The Karte's root wears `.phone-tools` (its docks stack like an Einsatz's), so
  `Karte.module.css` must keep the reader out of that two-bar box. Round 3 ended the reader a
  whole chip row higher AND let the fit reserve the row again.
  The box is only what the FIT measures: what is drawn is full-bleed (owner, round 4: a plan
  dragged down «doesn't neatly go behind all of the other bottom UI elements»). On the phone the
  stage does not clip at the box (`.wb-canvas { overflow: visible }`), so a dragged page slides on
  under «Zur Karte» and the bar to the screen's foot, with the stage's own ground behind it; the
  chrome floats over the plan.
- **The Gebäude is the Einsatz's, without editing** (owner, review round 4: «literally 1:1 the
  same as in the normal incident just without editing»). `KartePlans · KarteGebaeudeBoard` binds
  the object's floor pack IN MEMORY exactly as an Einsatz binds it (`lib/karte/gebaeude ·
  objectFloorBinding`: the first plan whose published metadata names floors, the approval on page
  0 else the first with an aspect — `useObjectPlans`' rule, under its sheet id), and from there
  runs the Einsatz's own pipeline: `floorPackOf` → the frame measured off the pages
  (`trimmedPackFrame`, bounded by `PACK_TRIM_MS`) → `packBuildingDoc` (the one builder of a pack
  stack, which the Einsatz's seed in `useGeorefFits` calls too) → the same read-only `Whiteboard`
  with `building` and `floorPack`. Storey labels, «Ausblenden», the stack's zoom and the compass
  are there; no building pick (`onBuildingFace` absent), no storey added or removed (`readOnly` + a
  pack stack), no compass turn (`onReorient` absent), no tools. A pack the station has not aligned
  takes the page's own size (the tile manifest) for the fit's aspect — an Einsatz would show no
  stack there; with neither, the plain storey list of round 2 stands in (`KarteFloors`). Nothing
  of it is stored.
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
- **A tool that waits for a tap takes every tap** (owner, review round 4, 17.10.2026: «while
  measuring we should also be able to measure on top of objects (not have the objects get
  highlighted)»). While Messen, «Punkt setzen» or Gefahrgut's centre (rings on) is armed, a tap on
  an object's outline, dot or name tag is a tap on the map at that spot: the dots and tags let the
  finger through (`pointer-events: none`), nothing is selected or highlighted, no sheet opens; the
  objects stay drawn (`lib/karte/camera · toolTakesTaps`).
- **Closing a selection gives the camera back** (owner, round 4: «… revert the position again so
  it doesn't constantly push the map south»). Selecting frames the place in the strip above the
  phone's sheet (beside the tablet's panel) with MapLibre's camera padding, which stays on the map
  after the move — so each select/close used to leave the map a sheet's height further south. The
  camera before the selection (centre, zoom, padding) is kept and eased back to (350 ms) when the
  sheet closes (✕, pushed down, a tap on empty map); a second selection while one is open keeps
  the first one's camera; a move the user makes themselves (a MapLibre `movestart` with an
  `originalEvent`) drops it, and the map stays where they put it. A pick from the search is a
  deliberate jump: closing it keeps the place and only drops the padding (centred on the whole
  map). The rule is pure: `lib/karte/camera · returnOnSelect / cameraOnClose`.
- **A plan row is the module, nothing else** (owner, review round 4: «just "modul 1", "modul 2",
  etc. is enough»; `lib/karte/plans · planRowLabel`): «Modul 1», «Modul 2-3», «Modul 5-PV»,
  «Modul 5-Wasser 1», «Modul 5-PV 15» — the key in words, a sub-slot word of up to three letters
  upper-cased (PV, RWA, AEH), a longer one capitalised (Wasser, Evak). No title, no «PDF · 1
  Seite · auf Karte ausgerichtet», no number badge; the «Gebäude» row says «Gebäude». Every row has
  one left edge and one height; offline the ●/◐/○ mark trails the words (its word for a screen
  reader in the label). A key that is no module key says the plan's title.
- **Plan titles** (`lib/karte/plans · planTitle`, the tablet rail and the view label): many sheets in the real catalogue are titled by
  their file name, «<object> – <module key>» («Migros – modul2», «Sägestrasse 8 - Schulhaus
  Hüslimatt – modul2-3»). Such a title gives way to the catalogue's title for the key («Wie komme
  ich herein», «Zugang & Objekt», «Photovoltaik»); a clean title («Übersicht», «Gemeindehaus –
  Übersicht») stays. A family sub-slot without an entry says its own name («Wasser»), a numbered
  sibling keeps its number («Wasser 2»), an unknown key reads «Modul N». The tablet rail's labels
  and the view label read the document's title; the panel's rows read `planRowLabel` (above).
- **A head that is still being looked up is a skeleton**, never «Gebäude» or «…» in place of a
  name: a tapped building until the register answers (a searched address is named at once), a
  dropped pin until its address is known. A plain building carries no «Kein Stationsobjekt …»
  box — the kicker says «Gebäude», the line under the name says «Kein Stationsobjekt» once known,
  and the closing «Keine Gefahrenangaben …» sentence still stands.
- **«Register-Hinweis» is tap to open** (owner, review round 4: «should be tap to open and this
  blabla (gwr, stand, etc.) should all be hidden by default»). Under «Gebäude laut Register» the
  chips stand, and so does «Registereintrag Grenzweg 7, nicht Grenzweg 1» right under them when
  the register's building is another address's (owner: keep it visible — the chips may be about
  the other building). The hint («Aus den Bundesregistern … Vor Ort prüfen.») and the source line
  (the registers and their Stand, the device's copy) are folded behind the «Register-Hinweis»
  toggle (`aria-expanded`), folded again for every place. The Einsatz's
  Gebäude card (`BuildingCard`) is a different component and keeps its hint as it was.
- **Missing is said.** A register that could not be asked, a place never looked at offline, an
  object without notes: each gets its sentence, and «Keine Gefahrenangaben … heisst nicht …»
  closes the panel. Nothing reads as «no hazard».
- **Doors by role.** «Objektbesuch» / «Melden» only for `objectVisits.captureRoles`
  (and only where the module runs); every other account reads the visits with a one-line reason.
- **Search** finds objects on the device first — name, address, aliases, folded umlauts, every
  word of the query — ranked name before alias/address, plans before none, then distance (`lib/karte/search`). Objects without coordinates are found and marked «ungefähr»
  (their place on the map comes from geocoding the address). Addresses follow from
  `/api/geocode/search`, online only, and say so offline. A row is glyph · name · address
  (· distance for a hit) — no plan count (owner, review round 2, 17.10.2026: «just the address is
  enough»; the sheet lists the plans; since round 3 the map tag carries no count either).
- **The address, never the kind word in its place** (review round 2). Plain objects are often
  named by their address with none stored; an object's address is the stored one, else
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
- **Ebenen: «Station» first** (owner, review round 4: «it's the most relevant one in this case»):
  the station group — Stationsobjekte and the colour categories — stands under the three chips and
  above Grundkarte, Inhalte, Wasser and Wetter (`LayerPanel · leadTwinGroups`). The Einsatz's
  Ebenen keep their order.
- **Typing on a phone** (review round 3, 17.10.2026 — round 2's keyboard handling did nothing on
  the owner's real iPhone). The bar is «Einsätze ▾» + a **search button** (its twin since round 4); the tablet keeps
  its field. Search and **Gefahrgut** are slide-ups with Ebenen's frame (`KarteKeySheet`): the field
  is the first line with the ✕ beside it, the results / the readout scroll under it. The search
  opens with the keyboard up (`primeKeyboard` inside the tap); a pick closes it and selects; it
  stays (at its Ebenen height) when the keyboard goes, until a pick or ✕ — a tap on the map then
  only lets the keyboard go. Gefahrgut likewise stays with its result after ✓; a tap on its tab
  with no UN number opens it with the caret in the field and the number pad up, with a number set
  it opens on the result without the keyboard (a Gefahrgut restored with the session never takes
  the caret — only a tap may raise iOS's keyboard). The map is not moved for the rings.
  - With the keyboard up the sheet keeps its height but stands **on the keyboard's top edge**,
    never taller than the room under the top bar less a 24 px strip of map
    (`lib/iosKeyboard · useKeySheet`, pure `keyboardTop` / `keySheetBox`).
  - Why round 2 failed: it trusted iOS to report its pan as `visualViewport.offsetTop` and
    counter-placed the card from that (`--vv-pan`). On the iPhone the page moved by ~the keyboard
    without that number saying so (the top bar, translated by it, never came back), and a drag on
    anything not scrolling moved it again. Now three guards that do not depend on one reading:
    the field is focused without a pan (`focusWithoutPan` / `noPanTouchEnd`, the react-aria
    technique), any pan that still happens is undone with `scrollTo(0, 0)` (rate-limited:
    `mayCorrect`), and while a field has the caret a touchmove nothing under the finger can scroll
    is cancelled (`useTypingLock`).
  - **Only the list scrolls** (owner, review round 4: «scrolling in the main search bar is rather
    ugly and moves everything»). The grab bar and the field line are the sheet's handle; a drag
    over the results is the list's alone — it never pulls the sheet, even at the list's top
    (`useSwipeDismiss · headOnly`), and the list neither rubber-bands nor hands its scroll on to
    the page at its ends (`overscroll-behavior: none`). The search sheet stands at its full
    height from the first frame (`KarteKeySheet · fill`), so a result list that grows or shrinks
    under the typing never moves the field. The iOS page lock above stays.
  - No «AutoFill Contact»: both fields come from one helper (`lib/typingField`) — a `search-…`
    name (Safari offers no contact AutoFill on a search), autocomplete / autocorrect /
    autocapitalise / spell check off, `enterKeyHint`, numeric for the UN field, and their label /
    placeholder words broken by an invisible word joiner (`defuseAutofill`) so Safari's keyword
    guess («Adresse», «Nr.») finds nothing. Messen, Ebenen and the Einsätze menu have no text field.
  - What is proven where: the shots run Playwright **WebKit** (iPhone 13 descriptor) with an iOS
    stand-in that shrinks the visual viewport, moves the page on focus (both as a window scroll
    and as an `offsetTop` pan) and moves it again under an uncancelled drag; the round-2 code
    reproduces the owner's screenshots there. The real keyboard, Safari's focus scroll and its
    AutoFill heuristics are only proven on the iPhone.
- **Hints use the width they need** (review round 2): «Auf die Karte tippen …» is one pill as wide
  as the bottom bar on a phone (max-content up to 640 px on a tablet), one or two lines; the
  Gefahrgut card says where its rings stand first, right under the UN field. The pill is the
  floating family's piece (01-tokens · `--float-*`): its row height, 14 px before a 16 px glyph,
  and 8 px above and below the words (round 4: the text sat 4 px from the rim on two lines).
- **The bar's and the sheets' controls are the app's** (owner, review round 4: «the search icon
  being round, the (x) size …»): the phone's search button is «Einsätze ▾»'s twin (44 px, the
  one corner, its frame) with the bar's 16 px glyph; every ✕ of the viewer — object sheet, search,
  Gefahrgut, Ebenen, phone and tablet — is the global `.ip-x` (36 px, 18 px glyph), 12 px in from
  the sheet's edge — except beside a field: the search's and Gefahrgut's ✕ is the field's height
  (44 px, owner's pick B: «field and ✕ in one row»); the phone's ⊙ / compass buttons wear the floating family's row height and edge.
- **Gefahrgut names the substance** (owner, round 4: «we also need to know the name (show it as
  attribute)»): the readout's first row is «Stoff» — the word of the Gefahrentafel's own field —
  with the ADR Table A name (`lib/unHazard · substanceName`: the curated English name on an English
  UI, else the German; Table A has no French or Italian names). The table holds one row per UN
  number. The Gefahrentafel's readout does not repeat it: its «Stoff» field already shows it.
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

Owner, 17.10.2026: colour the objects so that objects with plans, water plans, PV systems … are
told apart. The station sets ordered rules in the deployment config (Verwaltung › Station &
Karte › «Objektfarben», schema `ObjectCategoryConfig`), FIRST match wins:
`{ id, label: "…" | { de, fr, it, en }, color: "#rrggbb", match: { kinds?: [einsatzobjekt|objekt], modules?: [glob…] } }`.
A rule matches when every condition it names holds (none named = catch-all); `modules` globs
match the object's plan modules (`modul5-pv*` = `modul5-pv`, `-pv15`, `-pv20`). An object no rule
takes keeps the default look: red, ink-grey without plans. No rules = that default map.

- ⚠️ `kinds: ["depot"]` is **retired** (review round 3): the schema still accepts it, so an
  existing config stays valid, and it matches NO object — a rule naming only `depot` paints
  nothing (it must never turn into a catch-all); beside other kinds it is ignored. The admin
  card no longer offers it.
- The proposal for a station (staging, review rounds 2–3): «Mit Plänen» red `#dc2626`
  `{ kinds: [einsatzobjekt] }`, then «Ohne Pläne» grey `#64748b` `{ kinds: [objekt] }`, with the
  module rules (PV, Wasser) above them. A «Schlüsseldepots» rule has nothing left to colour —
  drop it.
- The map draws the object's dot, tag rim and outline (normal and selected) in the category's
  colour (`lib/karte/categories`).
- **Ebenen** has one row per rule under «Station» (glyph in the colour, «n Objekte»): off takes
  that category's objects off the map — outline, dot, tag and tap; the selected object stays. A
  device preference like the objects row (not kept across reloads).
- Pick colours that stay apart for the colour-blind (no red against green) and that read on the
  light, dark and aerial base maps.

## «Unterirdische Bauten» (owner, review round 4)

«can we show all subterraneous objects through our firegis database?» — FireGIS's
`av_gebunterird` is the official survey's underground buildings; the same features are in the
open AV WFS (geodienste.ch, Einzelobjekte `ms:SOSF`), so no FireGIS file is needed and every
deployment gets it. Drawn: `Art = unterirdisches_Gebaeude` and (owner on #383) the underground
traffic structures `Tunnel_Unterfuehrung_Galerie` — the survey has no other such type, and none
as lines. Not `Unterstand`.

- **Ebenen row** «Unterirdische Bauten» under «Station», OFF by default and off in «Standard»
  (`PresetRow.standard: false`); «Alle ein» switches it like any row. Not kept across reloads,
  like the other Station rows.
- **On the map:** every underground structure of the Einsatzgebiet as a dashed outline in the neutral
  ink (`--ink-dim`, never an object's red or a category colour), no fill, from z16 (street zoom),
  under the objects — an object's own dashed garage keeps its colour on top. Not tappable: a tap
  goes to whatever is above or under it, as before.
- **The area is the Einsatzgebiet** (owner on #383, not the geocoder's 27 × 18 km box): the
  municipalities of `map.serviceArea.municipalities` (BFS numbers), else the one the map centre
  (`map.defaultView`) lies in, as swisstopo's official boundaries (swissBOUNDARIES3D over the
  geocoder's host) — united with 500 m around every station object, so an object in the next
  village (ARA Birsig in Therwil) keeps its surroundings. A structure counts when any corner lies
  in that area.
- **Data:** `app/underground` asks the WFS for the municipalities' box and each outside object's
  surroundings in 3 km cells (a full cell is split), keeps each structure once, and stores ONE
  compact GeoJSON MultiPolygon (`reference/underground.json`). It rides the footprint job
  (`scheduler` · `_object_footprints_tick`): asked once, then weekly or when the area (a
  municipality, the map centre, an object's point) or the source changes; a failed ask keeps the
  stored set and waits an hour. FWO (Oberwil 2771 + the objects' surroundings, 18.10.2026): 1 058
  structures (392 of them outside Oberwil, 99 around the ARA), 243 KB, 58 KB gzipped, 3 s. No
  device ever asks the WFS.
- **`GET /api/reference/underground[?have=<fetchedAt>]`** (same readers as the catalogue):
  `{enabled, fetchedAt, count, geometry}`; `enabled: false` when off, `fetchedAt: null` before the
  first ask, `unchanged: true` without geometry when the device already holds that set. The
  device keeps it in IndexedDB (`lib/api/stationReference` · `loadUnderground`), asks the first
  time the row goes on per visit, and draws its copy offline; the service worker leaves the route
  alone (`NetworkOnly`, vite.config). A refusal (401/403) never shows the copy.
- **Off:** `UNDERGROUND_WFS=` (empty).

## Offline

The viewer never downloads anything on its own for offline use; it READS what the device already
holds and says so (`src/lib/karte/availability.ts` decides, `components/karte/useKarteOffline.ts`
and `KarteDevice.tsx` probe). No «ganze Station herunterladen»: that would be several GB (owner,
16.10.2026); deliberate downloads of chosen objects or areas come later.

| What | Where it is kept | Filled by |
|---|---|---|
| object catalogue | IndexedDB `kp-front-station-objects` (one entry) | every online open of `/karte` |
| register facts of a building | IndexedDB `kp-front-station-building:<where>`, the last 300 kept (index `kp-front-station-building-index`) | every building / object looked at online |
| plan PDF | the service worker's `reference-plans` cache, per revision URL | opening an untiled plan once online |
| plan tiles | `plan-tile-manifests` (the manifest) + `plan-tiles` (every tile), per revision | opening a tiled plan once online (the reader fetches the whole pyramid, `lib/planTilePrefetch`) |
| Gebäude storeys, aligned plan | the plan's pages (PDF or tiles) + the revision's alignment metadata (IndexedDB, `lib/api/reference`) | opening Gebäude / the aligned plan once online |
| base map | the service worker's `map-tiles` cache | looking at the area, or an Einsatz's Offline-Vorbereitung |
| Unterirdische Bauten | IndexedDB `kp-front-station-underground` (one entry, ~250 KB for FWO) | switching the row on once online |
| Gefahrgut (UN/ADR) | bundled with the app | — |

What the surface shows offline:

- **The bar's «Offline» chip** (a dot only on the phone) stands where the weather was and opens
  **«Auf diesem Gerät»**: Objektkatalog · Karte (this view) · Pläne (PDFs of the whole catalogue) ·
  Gebäuderegister · Gefahrgut · Adresssuche · Wetter/Fahrzeuge · Gerätespeicher (Pläne counts the
  plans that open here, by the rule above), each with ● on
  this device / ◐ partly / ○ only online AND the same in words. The Gebäuderegister is never ●: only
  buildings already looked at are stored.
- **A plan is held when the reader that will open it has what it needs** (`availability ·
  planLamp`): ● its PDF, or every tile of its pyramid; ◐ no PDF but the underlay tiles of every
  page — the whole sheet opens, a deeper zoom says «Schärfere Ansicht nur mit Netz»; ○ neither.
  ⚠️ A TILED plan opened online fetches its tiles and never its PDF (review round 3: the Karte said
  «PDF nicht gespeichert» offline for a plan its tiles open perfectly), so the PDF alone is never
  the rule, and no PDF is downloaded to make a lamp green. The probe reads the manifest from
  `plan-tile-manifests` and the tile cache's keys ONCE (`openPlanTilesProbe`), never one lookup per
  tile; `tilesHeld` decides.
- **Pläne & Module** rows carry ●/◐/○ after the words; a plan the device does not hold is dimmed
  (its label says «Nicht auf diesem Gerät gespeichert»), but stays tappable – the surface then says
  the plan is not stored instead of a reader spinning on a dead fetch. The tablet rail dims the
  same tiles. Gebäude is ● only when every revision's alignment metadata is stored and every
  storey's pages are fully (PDF or every tile), ◐ when some storeys are, or only as underlay (the
  stack then says some are missing). «Objektplan auf der Karte» is offered offline
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
- **A sharp base map on a retina screen** (owner, review round 4: «check why the map is so
  blurry»). The base rasters are 256 px tiles on MapLibre's 512 px zoom grid (`MapLayers` ·
  `tileSize={256}`), so each tile covers 256 CSS px: on a 3× iPhone every source pixel was blown up
  three times. A screen with `devicePixelRatio > 1` now asks CARTO for its `@2x` tile (512 px, the
  same area and label size; `lib/carto` · `withCartoRetina`): 1.5× on a phone, 1:1 on an iPad. It is
  decided where the layer list is derived (`workspace` · `builtinAndConfigLayers`), so the map,
  the Einsatz's offline download, the coverage probe and the readiness sheet all name the same
  tile — this is the Einsatz's map too. The Rapport's compositor gets the 1× template
  (`krokiPayload`, it lays 256 px). A 2× tile costs ~3× the bytes: the Offline-Vorbereitung's
  pre-flight prices it so (`storageBudget` · `tileBytesFor`). The 1× CARTO tiles a retina device
  held are dropped once (`tilePurge` · `carto-retina-2026-10`); a 1× screen keeps them. OSM and
  swisstopo have no 2× tiles; swisstopo's swissimage goes to z20 (was capped at 19, so the closest
  zoom stretched z19 four times). **The viewer stops at the visible base's last sharp level**
  (owner on #383): its last tile level drawn 1:1, i.e. map zoom `maxzoom − 1` on the 512 px grid
  (`lib/mapView` · `baseMaxMapZoom`: CARTO and swissimage 19, OSM 18) instead of 21, which stretched
  the last level 2–4×; switching to a base that ends sooner clamps the view. **Karte only**
  (`MapView` · `zoomCapAtBase`): the Einsatz map and the Tafel's Lagekarte keep 21 for precise
  symbol placement, the base soft past its last level there. Regression check, WebKit with the iPhone 13
  descriptor: `node site/check-basemap-sharpness.mjs --base <app>` (red above 1.5 device px per
  tile px or on overzoom; its header says how it stands in for CARTO's keyed tiles).
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
