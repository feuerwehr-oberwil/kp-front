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
    "address": "Schlossgasse 9", "lat": 47.52, "lng": 7.57,      // null when the station has none
    "aliases": ["Schlossgasse 9 - Wasserschloss"],
    "plans": [{ "id": "plan:<uuid>:modul23", "module": "modul23", "code": "2/3", "title": "…",
                "pages": 3 | null, "georef": true, "version": 2, "updatedAt": "…" }],
    "floors": [{ "index": -1, "name": null }, { "index": 0, "name": "Hauptebene" }],
    "egid": null, "footprint": null,
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
- **`aliases`**: the plan library's folder name when it differs from the name and address.
- **`plans`**: the object's PDF datasets with bytes, by module. `code` is the module key without
  «modul» («23» → «2/3»). `pages` comes only from a tile manifest the server already wrote
  (`plan_tiles.stored_page_count`) – the listing never opens every PDF – so it is `null` when
  unknown. `georef` is true when the CURRENT revision has an approved fit that passes the same
  gate as `GET /api/reference/{id}/alignments` (`plan_floors.fit_publishable`).
- **`floors`**: the Geschosse of the current revisions' floor packs, by signed index; the words
  («EG», «1. OG») are the client's copy (`lib/whiteboard · floorLabel`), the station's own name wins.
- **`egid` / `footprint`**: no station source carries either today, so both are `null`. The viewer
  then outlines the map building that CONTAINS the object's coordinate. It never picks a building
  by proximity alone.
- **`lastVisit`**: the latest COMPLETED Objektbesuch (drafts and discarded visits are not visits
  that happened), only where the station runs the module or for the admin session.

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
entry). Reached for now from the launcher's «Karte & Objekte» row; a deep link at start opens no
Einsatz behind it (the same rule as `/besuche`). Not for a link session.

What it reuses, so nothing forks:

| Piece | Reused from |
|---|---|
| map, layers, vehicles, measure path, georef raster, weather radar | `MapView` (read-only, no drawings) + `MapLayers` (a `polygons` overlay kind draws the outlines) |
| Ebenen | `LayerPanel`, under its OWN device key (`kp.layers.karte`, `lib/karte/session`), without the Einsatz-only layers (taktisch, Skizzen, Personen); the radar's choice too (`kp.karte.radar`) |
| tools | the Einsatz's `ToolRail` (tablet) / the folded `navrail` bar (phone), `ToolDock` + `MeasurePanel` WITHOUT «Als Linie/Fläche übernehmen», `MapViewsButton` without saved views |
| weather | `useWeather` + `WeatherBadge` |
| plans | the NavRail classes and `PlanGlyph`, `PlanChooser` on the phone, `PdfScroller` on the current revision; the Gebäude storeys as the floor pack's page regions (`planRegionCropUrl`, what `FloorPage` draws from) |
| register facts | `lib/buildingCard` (chips, source line), the same «Register-Hinweis» |
| Gefahrgut | `UnHazardSection` — the Gefahrentafel's ADR/ERG block, extracted from `ContextPanel` |
| building outlines | the Umriss picker's `/api/overpass/buildings` (station snapshot first), loaded per grid cell (`lib/karte/outlines`) |

The rules that are easy to break:

- **Own state, never an Einsatz's.** No workspace, no saved drawing, no plan binding, no journal
  row. Measurements, the Gefahrgut rings and a dropped pin are component state; only the Ebenen and
  the view (`KarteView`: frame, selected object, open plan, in sessionStorage) are kept —
  `karteViewSnapshot` is the one door into storage (`lib/karte/karte.test.ts` pins it).
- **A building is an object only by containment or an exact address.** An object is drawn as the
  OSM outline that CONTAINS its own coordinate; a tapped building opens an object only when the
  register's street + number equals the object's (`lib/karte/places`). A key box at the same door
  is not the building. No outline under a point → no building.
- **«In der Nähe» is distance only**, and the panel says so in a sentence.
- **Missing is said.** A register that could not be asked, a place never looked at offline, an
  object without notes: each gets its sentence, and «Keine Gefahrenangaben … heisst nicht …»
  closes the panel. Nothing reads as «no hazard».
- **Doors by role.** «Objektbesuch» / «Meldung erfassen» only for `objectVisits.captureRoles`
  (and only where the module runs); every other account reads the visits with a one-line reason.
- **Search** finds objects on the device first — name, address, aliases, folded umlauts, every
  word of the query — ranked name before alias/address, plans before none, key boxes last, then
  distance (`lib/karte/search`). Objects without coordinates are found and marked «ungefähr»
  (their place on the map comes from geocoding the address). Addresses follow from
  `/api/geocode/search`, online only, and say so offline.
- **Visits hand over** to the existing capture: `/besuche/neu?object=<id>&from=karte` for an
  object, `/besuche/neu?lat=&lng=&label=[&address=]&from=karte` for a building or a pin (contract
  C1, label «bei <Adresse>» within 60 m of a pin, else «Gesetzter Punkt»). The viewer stays
  «entered» while that visit is open, so the way back lands on it.
- **Alarms** reach the viewer through the Meldeleiste and the same two banners as the
  Objektbesuche; nothing switches by itself. A running Einsatz is the red chip in the bar (a strip
  under it on a phone); a tap opens it.

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
- **Search:** station objects are found on the device; the address search says it needs the
  network. **Objektbesuche** say they need the network and name the catalogue's last visit.
- The catalogue shown from the device is replaced by the server's as soon as it answers again
  (`lib/connectivity · onReachable`, the `online` event), without touching the selection.

⚠️ «●» only for what a probe actually FOUND. Without a service worker controlling the page (a dev
server, a first visit) nothing is served from Cache Storage once the network is gone, so every
cache-backed row reads «nur online» – never a guess. A failed IndexedDB read is not «held» either.
