# CONFIGURATION — what a station must provide, and in what format

**Status:** Live configuration contract. The Tier-2 config layer is implemented as a DB-backed
`deployment_config` document, with CLI/config-file tooling as the primary administration path and
the in-app admin UI used for visual inspection, basic changes, and sanity checks.

This document is the **data contract** every other piece builds on: what a station keeps in its
private config/data repo, what the CLI validates and loads, what the admin UI visualizes, and what
the backend validates.

---

## 0. The four layers (recap)

| Layer | What | Where | Editable by |
|-------|------|-------|-------------|
| **Defaults** | National/safe fallbacks (FKS doctrine, symbol presets) | `src/config/appConfig.ts` | developers |
| **Deployment config** ← *this doc* | Per-station settings + uploaded assets | DB `deployment_config` row + asset storage | technical deployment owner via config file/CLI; admin UI for inspection/basic edits |
| **Secrets / infra** | DB URL, API keys, session secret | environment variables | operator (deploy time) |
| **Per-incident settings** | Live operational knobs (synced) | workspace blob (`IncidentSettings`) | any **user**, in-incident |

**Resolution:** per-incident overrides deployment config overrides defaults. **An empty
deployment config is valid** — the app must run as a generic, empty station (see `§8 Empty
state`).

---

## 1. Deployment config (the JSON the deployment owner edits)

One JSON document, stored as the single `deployment_config` row, returned by `GET /api/config`.
**Every field is optional**; anything omitted falls back to the national default.

```jsonc
{
  "identity": {
    "appName": "Feuerwehr Musterdorf",        // shown in title bar, login, help; default "KP Front"
    "locale": "de-CH",                          // "de-CH" today; "fr-CH" / "it-CH" later
    "accentColor": "#c4161c",                   // must flow through the --accent token system
    "assets": {                                 // see §3 for upload rules
      "logo": "logo.svg",                        // ref into asset storage
      "iconPng192": "icon-192.png",
      "iconPng512": "icon-512.png",
      "favicon": "favicon.svg"
    },
    "helpIntro": "… ist die digitale Lage- und Einsatzführung der Feuerwehr Musterdorf …",
    "kommandant": "Maj Hans Muster"             // pre-fills the Kommandant signature line on the Einsatzrapport
  },

  "map": {
    "defaultView": {
      "center": [7.55604, 47.51510],            // [lon, lat] WGS84 …
      "centerLv95": null,                         // … OR [easting, northing] EPSG:2056 (one of the two)
      "zoom": 16
    },
    "geocoder": {
      "defaultLocality": "4104 Musterdorf BL",   // appended to bare street addresses; "" = none
      "bboxLv95": "2598000,1252000,2625000,1270000"  // "minE,minN,maxE,maxN" to rank local hits; "" = national
    }
  },

  "referenceLayers": [ /* see §2 — entirely station-supplied, none bundled */ ],

  "fleet": {
    // Station vehicles for the Alarmierungs-/Ausrückzeiten grid (rapport form, paper
    // Erfassungsblatt, milestone webhook matching, stats export). `id` should equal the
    // sender's device name (Traccar convention). Empty = every vehicle-times surface hidden.
    "vehicles": [],                               // e.g. { "id": "tlf", "label": "TLF", "winfapAlias": "TLF" }
    // Data-driven Auswahl-Vorschläge: each entry attaches a suggestion list to one symbol
    // field. `field` is "title" (the symbol's title combobox) or a detail-row key (e.g. "Typ",
    // "Einheit"). Free typing in the Lage always stays possible — these only prefill. Edit in
    // Verwaltung › Fahrzeuge & Geräte, or edit in the config JSON and load via CLI.
    "attributeLists": [
      { "symbol": "VKF Fahrzeug",          "field": "title",   "options": ["TLF", "ADL", "HLF", "ELW"] },
      { "symbol": "VKF Luefter mobil",     "field": "Typ",     "options": ["Überdruck", "Elektro"] },
      { "symbol": "FW Kleinloeschgeraet",  "field": "Typ",     "options": ["Wasser", "Schaum", "CO₂"] },
      { "symbol": "VKF Bereich Feuerwehr", "field": "Einheit", "options": ["Stützpunkt", "Nachbarwehr"] },
      { "symbol": "VKF Bereich Sanitaet",  "field": "Einheit", "options": ["Rettungsdienst", "Rega"] },
      { "symbol": "VKF Bereich Polizei",   "field": "Einheit", "options": ["Kantonspolizei"] }
    ]
    // Legacy fixed fields (vehicleTypes/luefterTypes/kleinloeschTypes/partner) are still
    // accepted as a compatibility fallback; normalize them into attributeLists in config.
  },

  "doctrine": {                                  // FKS defaults shown; override per corps
    "defaultFunkkanal": 11,                       // null = no preset (national default)
    "funkkanalMin": 1, "funkkanalMax": 99,
    "mindestBar": 60,                             // critical minimum — low-pressure highlight
    "contactIntervalMin": 5,                      // SCBA contact interval — "Kontakt fällig" (amber)
    "contactGraceSec": 60,                        // Nachfrist after the interval before the überfällig alarm
    "defaultPressureBar": 300, "pressureStep": 10, "pressureMax": 320
  },

  "roster": {
    "source": "manual"                            // "divera" | "manual" (CSV/hand) — see §4
  },

  "mittel": {                                    // material-use sheet (Mittel): billing/report + "brauchen wir mehr?"
    // Station catalogue of materials/equipment crews use up OR deploy (consumables like Ölbinder
    // AND reusable gear like Lüfter/Wärmebildkamera). `unit` seeds the entry's default unit
    // (editable per incident); `category` groups the picker + Bestand view; optional `stock` is
    // the nominal per-source load-out (→ used/available readout + the Bestand overview, where
    // sources omitted = none there). Anything not listed → type «Anderes Mittel» in-app.
    "catalogue": [
      { "id": "oelbinder",        "label": "Ölbinder (Granulat)", "unit": "Sack", "category": "Ölwehr" },
      { "id": "luefter",          "label": "Lüfter",              "unit": "Stk",  "category": "Geräte",
        "stock": [ { "source": "tlf", "qty": 1 }, { "source": "pio", "qty": 1 } ] },   // → MoWa: none
      { "id": "atemschutzgeraet", "label": "Atemschutzgerät",     "unit": "Stk",  "category": "Atemschutz" }
    ],
    "sources": [                                  // where a Mittel was drawn from — optional per entry,
      { "id": "tlf",     "label": "TLF" },        // typically the vehicles + the depot. The picker
      { "id": "pio",     "label": "Pio" },        // offers exactly this list (no free-typed sources).
      { "id": "magazin", "label": "Magazin" }     // `stock[].source` references these ids.
    ],
    "units": ["Stk", "l", "Sack", "Flasche", "Dose"]  // unit suggestions for custom entries; free text always ok
  },

  "alarms": {                                    // alarm auto-open + auto-archive
    "autoOpen": false,                            // NEW Divera alarm → incident, no human in the loop
                                                  // (generic POST /api/alarms always creates — its env
                                                  // secret ALARM_WEBHOOK_SECRET is the opt-in, §6)
    "autoOpenPriorities": null,                   // e.g. ["HIGH"]; null = all
    "autoOpenKeywords": null,                     // case-insensitive substrings of title+text; null = all
    "autoArchiveDays": 7,                         // archive untouched auto-opened incidents (never any
                                                  // workspace sync) after N days; 0 = sweep off
    "captureWindowHours": 12,                     // how long the Erfassungs-Poster link (below) reaches
                                                  // an incident after it opened
    "webhooks": [],                               // outbound: POST on every incident creation (payload +
                                                  // adapters: docs/ALARM-INTEGRATIONS.md); fail-open
    "groups": []                                  // station alarm groups for the Alarmierungs-/Ausrück-
                                                  // zeiten grid (rapport form, Erfassungsblatt, milestone
                                                  // webhook, stats export). Empty = grid hidden. Example:
                                                  // { "id": "g2", "label": "Gr. 2", "color": "Rot",
                                                  //   "winfapAlias": "2", "tagespikett": false }
  },

  "report": {                                    // Einsatzrapport form presets
    "partnerOrgs": []                             // Partnerorganisationen checkbox row (paper + form);
                                                  // empty = no preset row, free text stays possible
  },

  "integrations": {                              // ON/OFF only; credentials live in env (§6)
    "diveraEnabled": false,
    "traccarEnabled": false
  }
}
```

> **Validation:** the CLI/backend reject malformed config and CRS ambiguity (both `center` and
> `centerLv95` set). Asset-reference validation is tied to the asset-upload path; until then,
> config review should verify referenced files exist in the deployment store.

---

## 2. Reference / werkleitungs layers — **station-supplied, nothing bundled**

No layers ship with the app except the swisstopo/OSM base maps (§7). Every operational
reference layer (hydrant, water/gas/electricity mains, hazard zones) is entered by the station.
Two kinds, mirroring the existing `LayerDef`:

### 2a. Raster layer (WMS / WMTS) — *paste a URL template*
```jsonc
{
  "id": "bl-hochwasser",
  "group": "Gefahren",                 // Wasser | Abwasser | Gas | Strom | Gefahren | (custom)
  "label": "Hochwasser",
  "icon": "drop",                       // drop | warn | hex | map | sat
  "kind": "wms",                        // "wms" | "wmts"
  "tiles": ["https://geowms.example.ch/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&LAYERS=<LAYER>&BBOX={bbox-epsg-3857}"],
  "opacity": 65,
  "maxzoom": 21,
  "attribution": "© Geodaten Kanton …"
}
```
- The endpoint **must support EPSG:3857** tiling (`{bbox-epsg-3857}` / `{z}/{x}/{y}`) and **must
  send CORS headers** (the browser fetches it directly). Use the admin UI as a visual check for
  individual layer changes; keep the manifest/config file as the source of truth.
- Station gets the URL + layer name from its canton/commune GIS GetCapabilities.

### 2b. Vector layer (GeoJSON) — *for points/lines you own*
```jsonc
{
  "id": "hydrant",
  "group": "Wasser",
  "label": "Hydranten",
  "icon": "drop",
  "kind": "geojson",
  "geojson": "/api/reference/geo:hydrant",  // same-origin reference-store URL
  "vectorKind": "point",                // "point" | "line"
  "symbol": "SI Ueberflurhydrant",       // optional: render points as this FKS symbol
  "color": "#0f52b5",
  "nightColor": "#5b9bff",
  "attribution": "© Wasserversorgung Musterdorf",
  "autoActivate": ["Brandbekämpfung"]     // optional: Einsatz categories that auto-show this layer
}
```

`autoActivate` (also valid on raster layers) names the **Einsatz categories** — the German
VKF `kategorien` values (`Brandbekämpfung`, `Elementarereignis`, `Ölwehr`, …) — for which the
layer switches itself visible: when an incident of that category is opened for the first time,
and additively when an incident is later re-categorized (a BMA that turns out to be a real
fire brings the hydrants up). It only ever turns layers **on**, and once the operator has
toggled layers in an incident their choice is authoritative — a deliberately hidden layer is
not re-forced on reopen. Unset = the layer never auto-activates (the default).
You don't write the `geojson` URL by hand: load the file with the **`admin_geodata` CLI**
(§9c) from a *manifest* — a layer entry plus a `file:` pointing at the GeoJSON. The CLI puts
the file in the reference store and writes this render config (with the resolved
`/api/reference/geo:<slug>` URL) into `referenceLayers`. The in-app **Datenquellen** panel is
for inspection and simple one-off changes, not the long-term source of truth. Restricted data
(e.g. utility cadastre) stays in a **private data repo**, never in this one.

---

## 3. Uploaded assets & their formats

Stored in the configured asset store (local volume by default; S3 optional). Limits follow
`MAX_UPLOAD_MB` (§6; default 110).

### 3a. Branding
| Asset | Format | Notes |
|-------|--------|-------|
| Logo | SVG (preferred) or PNG | shown in login/header; transparent background |
| App icon | PNG **192×192** and **512×512** | PWA / home-screen |
| Favicon | SVG or ICO | browser tab |

### 3b. Hydrants — GeoJSON
- **Type:** `FeatureCollection` of `Point` features.
- **CRS:** **WGS84 (EPSG:4326), `[lng, lat]`** — per RFC 7946. The app does **not** reproject;
  `admin_geodata` and the upload panel **reject** LV95-looking coordinates. Convert at the edge
  first (the private data repo's `leitungskataster_to_geojson.py` reprojects LV95 → WGS84).
- **Properties (all optional; geometry is the only requirement):**
  | property | meaning | example |
  |----------|---------|---------|
  | `type` | Über-/Unterflur | `"Überflurhydrant"` |
  | `nummer` / `id` | hydrant label | `"OH 045"` |
  | `leistung` | flow | `"1600 l/min"` |
  | `nennweite` | diameter | `"DN 150"` |
  | `druck` | static pressure | `"4.5 bar"` |
  - Unknown properties are ignored; they surface in the symbol detail panel.

### 3c. Plans (object plans) — PDF
- One PDF per module. The **module key** is parsed from the filename/field; accepted forms
  (already normalized in `useObjectPlans`):
  `modul1`, `modul2`, `modul3`, **`modul2-3` / `2-3` / `Modul 2/3` / `modul2_3`** (combined
  Zugang+Objekt sheet → single 2/3 tile), `modul6`.
- Module meaning (FKS object-plan doctrine):
  | key | title | content |
  |-----|-------|---------|
  | `modul1` | Übersicht | situation / access overview |
  | `modul2` | Wie komme ich herein | surroundings + accesses |
  | `modul3` | Was finde ich drinnen | Haupthahn, BMA, RWA |
  | `modul2-3` | Zugang & Objekt | combined 2+3 on one sheet |
  | `modul6` | Gebäudepläne | floor plans |
- Built-in, non-uploaded plan tiles (always available): `osm` (live OSM building outlines) and
  `tafel` (blank sketch sheet).
- **Objects** (which plans belong to which building) come from the backend reference store
  (`/api/reference/objects`); a station with no object data simply has no object plans — the
  `osm` and `tafel` sheets still work.

---

## 4. Roster / personnel

`roster.source` selects how `Person` records are populated.

### 4a. `"divera"` — auto-sync
- Requires a Divera access key in env (§6). The backend syncs Divera personnel → `Person`.
- No file needed; the admin UI shows the synced roster read-only.

### 4b. `"manual"` — CSV import + hand entry
- Admin imports a CSV and/or adds people in the UI. **CSV columns:**
  | column | required | meaning |
  |--------|----------|---------|
  | `name` | ✅ | display name ("Hptm Meier") |
  | `funktion` | – | role/Funktion (Einsatzleiter, Maschinist, …) |
  | `einheit` | – | unit/Zug/Gruppe |
  | `default_funkkanal` | – | integer |
  | `divera_id` | – | for later reconciliation if they adopt Divera |
- Encoding UTF-8, comma-separated, header row required. Extra columns ignored.

> Either way, the **app stays usable with an empty roster** — every person picker (Einsatzleiter,
> Fahrer, Trupp names) offers free-typing, so a station can run before importing anyone (§8).

---

## 5. User accounts, roles, and deployment administration

Not part of `deployment_config` — operational users are managed separately from station config.
The product role model is deliberately small:

- **Login:** pick your name from the roster → enter your **PIN** (fast at 3am, per-person
  identity for the audit trail). JWT access (8h) + refresh (7d) with rotation + revocation.
- **Roles:** `editor` (FU / Einsatzleitung support; can mutate incident state) and `viewer`
  (read-only display/follow mode). The stored role value was migrated from the legacy `commander`
  name to `editor` on 2026-06-30.
- **Deployment administration:** does not depend on being an incident editor. The `/admin` UI
  and the admin-write API (config, branding, system, user CRUD, geodata/objects) are gated on the
  **`ADMIN_SECRET`** env var (a deploy-time secret), *separate* from the editor PIN. Unlock once
  with the secret to get a short admin session; the `admin_geodata`/`admin_objects` `push` CLI
  authenticates the same way (`KP_ADMIN_SECRET`). **Fail-closed:** if `ADMIN_SECRET` is unset the
  admin surface is disabled (every admin endpoint returns 403) — it never falls back to the editor
  PIN. Use it for config/user maintenance, not for 3am incident work.
- **Account source of truth:** preferably config/CLI/seed file for deployers, with the admin UI
  for inspection, PIN reset, deactivation, and simple changes. **PIN reset is admin-driven** (no
  email recovery).

---

## 6. Environment variables (secrets / infra — operator, not admin)

Set at deploy time; never editable from the UI, never in the repo.

| Env var | Purpose |
|---------|---------|
| `DATABASE_URL` | Postgres connection (`postgresql://…`; auto-upgraded to asyncpg) |
| `SECRET_KEY` | JWT signing + PIN pepper (≥32 chars; **required in prod**) |
| `ADMIN_SECRET` | unlocks the `/admin` UI + admin-write API/CLI, separate from the editor PIN (≥16 chars; empty = admin disabled, fail-closed) |
| `MEDIA_STORAGE_DIR` | local asset/media dir (default `data/storage`) |
| `S3_*` | optional: bucket/endpoint/keys if using object storage |
| `DIVERA_ACCESS_KEY`, `DIVERA_WEBHOOK_SECRET` | if `diveraEnabled` |
| `ALARM_WEBHOOK_SECRET` | generic alarm intake `POST /api/alarms` for non-Divera alerting systems — auto-opens an incident per alarm, idempotent on `source`+`source_id` (empty = endpoint disabled, fail-closed) |

> **Erfassungs-Poster (station capture):** not an env var — the poster token lives in the DB and is
> managed in the admin UI (Personen › Erfassung): activate/rotate/disable, print the A4 poster.
> Scanning it opens `/e/<token>`, where attendance/material/notes for incidents of the last
> `alarms.captureWindowHours` are recorded without a login. Fail-closed: no token → the whole
> `/api/capture/*` surface answers 403. Rotation invalidates every printed poster at once. |

> **Statistik-Export:** also DB-stored, managed in the admin UI (Datenquellen › Statistik-Export).
> `GET /api/stats/incidents?year=` returns one flat read-only JSON record per incident (metadata,
> Zeiten, Anwesenheit von–bis, Mittel totals, Rapport status) for external analytics — auth via
> `X-Stats-Token` header or `?t=`. Fail-closed: no token → 403. Full field reference:
> `docs/STATS-EXPORT.md`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push for killed-app alarms + new-alarm push (generate once: `cd backend && uv run python -m app.gen_vapid`; empty = push disabled, fail-closed) |
| `PRINT_AGENT_SECRET` | station print relay: «An Stationsdrucker» queues the Einsatzrapport-PDF for an on-site agent (`tools/print_agent.py` — any always-on box with a CUPS queue; `python3 tools/print_agent.py install` prints the setup). Empty = agent endpoints 403 and the button never renders, fail-closed. |
| `TRACCAR_URL`, `TRACCAR_EMAIL`, `TRACCAR_PASSWORD` | if `traccarEnabled` |
| `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`, `STT_LANGUAGE` | speech-to-text for the audio player's Transkribieren (OpenAI-compatible `/v1/audio/transcriptions`; base URL without `/v1` — Groq: `https://api.groq.com/openai`, OpenAI: `https://api.openai.com`, or a self-hosted faster-whisper server). Empty base URL = off, fail-closed. **Audio is sent to that server** — prefer self-hosted for sensitive deployments. |
| `MAX_UPLOAD_MB` | request-body cap for multipart uploads (default 110 — must stay above the media endpoint's 100 MB per-file cap) |
| `GEOCODER_URL` | address-autocomplete endpoint (default the swisstopo SearchServer — see the caveat below) |
| `SEED_DATABASE`, `DEV_CREATE_ALL` | dev seeding / auto-create tables (prod uses Alembic) |

Weather (MeteoSwiss/Open-Meteo) and the swisstopo geocoder need **no** credentials — public
endpoints, national, work everywhere *in Switzerland*. One honest limitation: the geocoder
client speaks the swisstopo SearchServer API shape only, so outside Switzerland address
autocomplete simply returns nothing (map-pick still works). `GEOCODER_URL` exists to point at
a *compatible* endpoint (e.g. a proxy) — it is **not** a generic-geocoder swap point for
Nominatim/Google/etc.

---

## 7. What ships with the app (no config needed)

- **Base maps:** swisstopo (farbig/grau/SWISSIMAGE via WMTS), OpenStreetMap, Carto (incl. the
  night theme), Esri/OpenTopo. National coverage, day one.
- **FKS symbol set:** the KP-Front-authored library (`public/tactical-symbols.json`, generated
  by `tools/gen_symbols.py`) + presets + display names. **Not station-editable** — keeps
  stations interoperable.
- **Weather/wind, geocoder:** national public services.

## 8. Empty state (a brand-new deployment)

A deployment with an empty config must be fully operable:
- swisstopo base map, centered on a neutral default until `map.defaultView` is set;
- no reference layers, no hydrants, no plans, no roster — and **nothing errors**;
- every person/unit picker offers **free-type entry** (no "select from empty list" dead-ends);
- optional layers/integrations that aren't configured are shown as "nicht konfiguriert", never
  as empty-but-implied-complete.

## 9b. Loading a station config (`admin_config`)

A station's config is a JSON file (matching §1) loaded with the admin CLI
`backend/app/admin_config.py`. This is the preferred path for technical deployment owners and
LLM-assisted edits: reviewable config file, schema validation, diff, then load. The admin UI is
useful for inspection and small corrections, but it should not replace a private config/data repo
for geodata, object plans, and repeatable deployment setup. Station config files are private and
**never committed** (`backend/private/` is gitignored).

The CLI is built for config-as-code (LLM/agent-friendly): the loop is
**`schema` → author → `validate` → `diff` → `load`**. `schema`/`example`/`validate`/`diff`
(against a file) need no DB; `show`/`load` hit the configured `DATABASE_URL`.

```bash
# from backend/
uv run python -m app.admin_config schema            # the config JSON Schema (the contract)
uv run python -m app.admin_config example           # a populated sample to edit
uv run python -m app.admin_config validate private/<station>.config.json   # parse+validate, no write
uv run python -m app.admin_config diff private/<station>.config.json        # what would change vs stored
uv run python -m app.admin_config load private/<station>.config.json        # validate + upsert
uv run python -m app.admin_config show              # print the stored config
```
Invalid input prints precise `field.path: message` lines and exits non-zero (nothing written).

Against the Railway production DB from a workstation, inject the public proxy URL (no secrets
printed):

```bash
railway run -s Postgres -- bash -lc \
  'cd backend && DATABASE_URL="$DATABASE_PUBLIC_URL" uv run python -m app.admin_config load private/<station>.config.json'
```

The empty/neutral default row is seeded on first boot (`seed_config.py`); this CLI overwrites
it with the station's values. An empty config is always valid (§8).

## 9c. Loading reference geodata (`admin_geodata`)

Reference layers (§2) are loaded separately from the rest of the config, because they pair
render config with GeoJSON **files**. A station keeps those files + a **manifest** in a private
data repo and loads them with `backend/app/admin_geodata.py` — the GeoJSON goes into the
reference store (served at `/api/reference/geo:<slug>`) and the render config is written into
`deployment_config.referenceLayers`. Same loop as `admin_config`:

```bash
# from backend/
uv run python -m app.admin_geodata schema             # the manifest-entry JSON Schema
uv run python -m app.admin_geodata example            # a sample manifest to edit
uv run python -m app.admin_geodata validate <dir>/geodata.manifest.json   # + validates every GeoJSON (no DB)
uv run python -m app.admin_geodata load <dir>/geodata.manifest.json       # upload files + write referenceLayers
uv run python -m app.admin_geodata show               # print the stored referenceLayers
```

A manifest entry is a `referenceLayers` entry (§2) plus, for a `geojson` layer, a `file:`
(local GeoJSON, relative to the manifest) instead of a pre-resolved URL. GeoJSON is validated
as a **WGS84 `[lng, lat]`** FeatureCollection (LV95 rejected, §3b). Layer `id`s match what the
frontend persists as `layerState`, so saved layer visibility carries across a refresh.

**Storage caveat for remote loads.** A full `load` writes the GeoJSON to the *local*
`MEDIA_STORAGE_DIR`, so run it **server-side** (where storage = the server volume) for a fresh
deployment — or push the files through the in-app **Datenquellen** upload (which goes via the
API to the server's store). From a workstation against a remote DB, use **`load --config-only`**
(inject `DATABASE_PUBLIC_URL`, like `admin_config`): it writes just `referenceLayers` and never
touches files, so it can't point rows at GeoJSON that isn't on the server.

## 9d. Loading checklists (`admin_checklists`)

Checklist templates (the FU action list, the Lagerapport agenda, the EL tactical playbook) are
station data too: one `ChecklistTemplate` JSON per list — plus playbook diagram images for
`reference` templates — and a `checklists.manifest.json`, kept in the private data repo and
loaded with `backend/app/admin_checklists.py`. Each template becomes a `checklists:<id>`
reference dataset (diagram pages as `checklists:<id>:p<N>`), served at
`/api/reference/checklists:<id>` and fetched + offline-cached by the Checkliste surface
(`loadTemplates` in `src/lib/checklists.ts`). With nothing loaded, the app falls back to one
neutral bundled example (`src/data/checklists/generic-action.json`) — never a station's real
lists. Same loop as the other CLIs:

```bash
# from backend/
uv run python -m app.admin_checklists schema             # the manifest-entry JSON Schema
uv run python -m app.admin_checklists example            # a sample manifest to edit
uv run python -m app.admin_checklists validate <dir>/checklists.manifest.json  # + checks every template/asset (no DB)
uv run python -m app.admin_checklists load <dir>/checklists.manifest.json      # upsert templates + assets (writes DB + storage)
uv run python -m app.admin_checklists push <dir>/checklists.manifest.json      # → running deployment (KP_BASE_URL / KP_ADMIN_SECRET)
uv run python -m app.admin_checklists show               # list stored templates + asset counts
```

The manifest is the single place a station controls checklist rail ordering (`order`), and
`load`/`push` **prune** stale `checklists:*` datasets not in the manifest, so renamed or
removed lists don't linger. Like `admin_objects`, `load` writes the local storage volume (run
it server-side); `push` goes through a running server's HTTP API (`ADMIN_SECRET`) so the
server writes its own volume — the way to refresh a remote deployment from a workstation.

## 9. Out of scope for this doc
- **Device preferences** (theme day/night/auto, symbol size) — per-device cookie, not synced.
- **Per-incident settings** (`IncidentSettings`: `contactIntervalMin`, `contactGraceSec`,
  `defaultFunkkanal`) — live in the workspace blob, default from `doctrine` above.
