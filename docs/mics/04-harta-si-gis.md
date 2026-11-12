# Hartă și GIS (Moldova / MICS)

**Authority:** [`CONFIGURATION.md`](../CONFIGURATION.md) §1h · [`geodata-architecture.md`](../geodata-architecture.md) · [`karte-objekte.md`](../karte-objekte.md) · [`sync-and-offline.md`](../sync-and-offline.md)  
**Demo pack:** [`examples/mics-data/`](../../examples/mics-data/)

## Motor (unchanged)

| Element | Value |
|---------|--------|
| Renderer | MapLibre GL JS — Lage and Karte & Objekte share the same base layers |
| Coordinates | WGS84 `[lng, lat]` everywhere the map renders |
| Built-in bases | CARTO Voyager (day) / Dark Matter (night); OSM view-only; swisstopo satellite is CH-only |

## Adapted for Moldova

| Subject | Status |
|---------|--------|
| `map.defaultView` centred on Chișinău (or the station town) | **Done** — station config; see `examples/mics-data/config.json` |
| Geocoder bias without LV95 | **Done** — `map.geocoder.bboxWgs84` + Nominatim path when `GEOCODER_URL` is not swisstopo |
| CARTO offline via «Offline-Vorbereitung» | **Done** — existing prefetch; use CARTO as visible base (not OSM bulk) |
| `referenceLayers` hydrants / objects | **Done** — load via `admin_geodata`; demo GeoJSON is synthetic |
| `map.buildingRegister: false` | **Done** in demo config (Swiss GWR/BFE) |
| PMTiles regional extract | **Planned** — not this change |
| Valhalla / local routing | **Out of scope** |

## Sources and conditions

Documented in [`examples/mics-data/README.md`](../../examples/mics-data/README.md): CARTO + OSM attribution and traffic; Nominatim self-host / contracted endpoint (not public OSM Nominatim for autocomplete); station GeoJSON for hydrants (IGSU / geodata.gov.md in production — never bundled here).

**Coverage checked (OSM/CARTO family):** Chișinău, Bălți, Cahul, rural Ghidighici — roads and localities strong in cities; rural addressing sparser; map-click remains the fallback. Duplicate street names are ranked with `defaultLocality` / `bboxWgs84`.

**Kroki / Rapport:** default CARTO tile hosts stay on the server allowlist; no change when the station keeps CARTO as base.

## Operator checks (tablet)

1. Day and night theme — CARTO labels readable.
2. Online: open Einsatz, search with/without diacritics, confirm pin WGS84.
3. Offline-Vorbereitung → disconnect → reload → map for prepared area; place / move / undo a tactical symbol.
4. Missing zoom / area → existing «no coverage» messaging.
5. Provider down → empty search / missing tiles; map-pick still works.
6. Swiss regression: Musterdorf `defaultView` + `bboxLv95` + swisstopo `GEOCODER_URL` unchanged.
7. Rapport Kroki with CARTO base — hosts already allowlisted (`app/kroki.py`).

## Automated checks (2026-11-12)

- `just test-backend` on geocode suites (bias, nominatim, geo_clients, street_dictionary, object_position): **pass**
- Admin/copy unit tests (`GeocoderOffer`, `ConfigScalars`, `copy.test`): **pass**
- `just openapi` regenerated (`bboxWgs84` in schema)
- Full `just ci` on this machine: unrelated macOS flakes (`find -printf` in restore/startup guards; Zeitplan clock label) — not caused by this change
