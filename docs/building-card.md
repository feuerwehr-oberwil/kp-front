# The Gebäude card

Status: 🟡 in review (KP Front idea F5, 2026-10-09).

The **Gebäude** chip stands in the bottom-left chip row of the **Karte**, and in the **Plan**'s
chip row beside the Objekt chip whenever an Objekt is bound (`components/BuildingFloat`). On a
phone it is part of the one floating row, left of the FAB. Closed, it names the hazards as glyph +
word («⚠ Gebäude-Info · Gas · PV»), or just «Gebäude-Info». A tap opens the card docked one row above it.
The card is non-modal, like the Passung: the map stays live, and ✕, the chip or Esc close it.
Until 09.10.2026 the card sat in the incident menu; the owner wanted it «on the map directly».

The chip is not pinned to the building on the map, for three reasons. The Lage is drawn exactly
at the Einsatzort, so a pinned chip would cover the Brandherd and the first vehicles. It would
move with every pan. And it would have no plan-side twin. The chip row is the same place on both
surfaces, and the floating row already budgets for it, with the message lane standing above it.
The Plan skips the chip where it skips the Objekt chip: on the Gebäude floor stack and on the Tafel.
It also skips it on a **phone**'s plan. That row is one line beside the FAB, and «⚠ Gas · PV»
squeezed the Objekt chip down to its glyph, so «which object are these plans of» went unanswered.
On a phone the Karte's chip is one tap away.

The card answers «what is this building» from four sources. Each one is optional and fails on its own:

| Half | Source | What it shows | Source line |
|---|---|---|---|
| Register facts | GWR (`ch.bfs.gebaeude_wohnungs_register`, identify at the Einsatzort) | Geschosse, Wohnungen, Baujahr or Bauperiode, heating and hot-water energy source, Zivilschutzraum, a status other than «bestehend» | «GWR ‹street› · Stand ‹export date›», «Heizung erfasst ‹date›» |
| Plants | BFE `ch.bfe.elektrizitaetsproduktionsanlagen`, joined **by EGID** | «PV 35.6 kW», other plants by their register label | «BFE abgefragt ‹date›» |
| Modul-1 notes | `ObjectSite.measures` / `remarks` / `measures_source` | the Einsatzobjekt's Sofortmassnahmen and Bemerkungen, one per line | «‹Objekt› · ‹source›», or «‹Objekt› · in der Nähe (‹m› m)» |
| Last visit | `object_visits` (completed, latest `visited_at`) | «Letzter Objektbesuch ‹date› · ‹n› Mängel» | the date itself |

The rules (3am tenet):

- **«Register-Hinweis», never a fact.** A heating entry can be years old, and only plants
  registered with Pronovo are in the BFE list, so «no PV in the register» is not «no PV».
  Every fact carries its source and date.
- **Hazards are a glyph and a word**: gas and oil (heating, or a hot-water boiler that adds a
  fuel the heating does not name) and PV are amber tags with the warn glyph. Never colour alone.
- **Nothing that nags.** A failed source, a building with no register entry, an object without
  notes draw nothing. A card with nothing to say is not drawn.
- The object is the plan rail's (`api/objects · ranked_objects_near`: address match, then the
  nearest within 400 m) or the operator's manual pick. When it was found by distance only, the
  card says «in der Nähe», because a neighbour's gas valve reads exactly like ours.

## API

`GET /api/incidents/{id}/building?lang=de|fr|it|en[&object=<uuid>]` → `BuildingOut`
(`backend/app/api/building.py`). `registers` says whether the federal registers were asked at all:
`off` (`map.buildingRegister: false`), `outside_ch` (the point is outside Switzerland's bounding
box), `no_location`. `gwr_status` / `pv_status` separate «could not be asked» (`error`) from
«had nothing» (`none` / `ok` with an empty list). The answer holds keys and numbers; the words
are the app's copy (`appConfig.copy.building`) in all four locales.

The alarm link may read it (it is live information about its own Einsatz). The visit half is left
out for every link session, and the Rapport view link may not ask at all. The object routes
(`/api/objects…`, `…/{id}/objects`) leave `measures`/`remarks`/`measures_source` out for every link
session, because the view link reaches them for its Rapport's plans, not for the station's notes.

The building is the GWR entry within 60 m (`MAX_DISTANCE_M`) of the Einsatzort; among those, one
whose street + number equals the incident's wins, otherwise the nearest. identify's search radius
is in pixels of a pretend image, so `identify_tolerance_px` sizes it to reach 60 m east–west, and the
result limit is high enough that the building is never cut. identify answers in no order.

## Caching and offline

- Server: per point + street, in-process. The answer is language-free (the plants keep the
  register's own labels in all four languages and are decoded per request). A clean answer is kept
  for a day; an answer with a failed source for two minutes, so a blip heals by itself. Concurrent
  requests for one key share one lookup (`building_facts.registers_cached`).
- Device: `lib/api/building.ts · buildingResilient` keeps the last answer per Einsatz in IndexedDB,
  stamped with the place it was asked for (`buildingWhere`: address + point), and serves it when
  the server cannot be asked, but only for the same place. A fresh answer in which a source failed
  keeps that source's half from the last good one: the GWR half only for the same place, the PV half
  only for the same EGID. A corrected address must never carry the old building's gas heating
  along. The hook fetches when the Einsatz opens (not when the menu does, so the copy is on the
  device before anybody needs it), and again when the address or point changes, when the manual
  object pick changes, and when the device comes back online.

## Sofortmassnahmen and Bemerkungen are station data, typed by hand

KP Front has no structured source for them. FireGIS prints them on the Modul-1 sheet. They get
into the app in two ways:

- **Verwaltung › Objektpläne**: the object mask has «Sofortmassnahmen», «Bemerkungen» and «Quelle».
- **`admin_objects`**: the manifest keys `measures`, `remarks` and `measuresSource` per object.
  They are written only when present, so a manifest without them never wipes what Verwaltung
  typed. `""` clears them.

Reading them off a station's PDFs is station-specific tooling and stays outside this repository.
The PDFs carry a text layer, but the text runs in no useful order: map labels clipped out of view
are mixed in. Read by position instead: the box between the «Sofortmassnahmen:» and «Bemerkungen:»
headings, in body size.

## Code lists

GWR catalogue 4.x, cross-checked against the register's decoded popup on 2026-10-08
(`backend/app/building_facts.py`): `genh*`/`genw*` → `gas` 7520, `oil` 7530, `wood` 7540–7543,
`district` 7580–7582, `air` 7501, `geothermal` 7510–7512, `water` 7513, `electricity` 7560, `solar`
7570, `waste_heat` 7550, `other` 7599 (and any code newer than the table), nothing for 7500 «keine»
and 7598 «unbestimmt». `gbaup` 8011–8023 → «≤1918» … «≥2016».
