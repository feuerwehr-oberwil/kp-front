# MICS demo station data (Republic of Moldova)

Synthetic configuration for a Chișinău-centred deployment. **Not operational cadastre.**

## Sources (basemap & search)

| Layer | Source | Coverage checked | Licence / conditions | Updated |
|-------|--------|------------------|----------------------|---------|
| Base map (day/night) | **CARTO** Voyager + Dark Matter (built into KP Front) | Chișinău, Bălți, Cahul, Ghidighici (rural) — roads, localities, building footprints via OSM | © CARTO, © OpenStreetMap; browser `CARTO_API_KEY` restricted to deploy domains; free-tier tile caps; device offline prefetch OK (not redistribution) | OSM continuously; CARTO tiles cached by CDN |
| Online view only | OpenStreetMap raster | Same OSM data | ODbL; **no** bulk offline prefetch | — |
| Satellite (`base-air`) | swisstopo swissimage | Switzerland only — leave unused for MD | © swisstopo | — |
| Address search | Nominatim-compatible `GEOCODER_URL` (not public nominatim.openstreetmap.org for production autocomplete) | Diacritics / ASCII; duplicate street names; WGS84 pins | OSM attribution; self-host or a hosted Nominatim with an acceptable use policy | — |
| Reference hydrants / objects | Station GeoJSON via `admin_geodata` | Demo file covers central Chișinău only | Station / IGSU / geodata.gov.md agreements — **never bundled as app defaults** | Demo pack: 2026-11-12 |

## Load order

1. Set env: `CARTO_API_KEY`, `GEOCODER_URL=<nominatim-root>` (https). Leave `UNDERGROUND_WFS` / `FOOTPRINT_*` / `HOUSES_WFS` empty (or accept OSM fallbacks). `WEATHER_LAYER_ENABLED=false` outside CH.
2. `just` / `admin_config load examples/mics-data/config.json` (or push to a running deploy).
3. `admin_geodata load|push examples/mics-data/geodata.manifest.json`.

`map.defaultView` is WGS84 `[lng, lat]`. `map.geocoder.bboxWgs84` biases Nominatim; leave `bboxLv95` null. `map.buildingRegister: false` (Swiss GWR/BFE).

## Offline

Use the in-app **Offline-Vorbereitung** with the CARTO base visible. After disconnect + reload, prepared tiles remain; place / move / undo a tactical symbol as usual. Missing zoom levels use the existing coverage messaging.
