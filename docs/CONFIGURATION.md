# CONFIGURATION – what a station must provide, and in what format

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
deployment config is valid** – the app must run as a generic, empty station (see `§8 Empty
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

  "referenceLayers": [ /* see §2 – entirely station-supplied, none bundled */ ],

  "fleet": {
    // Station vehicles for the Alarmierungs-/Ausrückzeiten grid (rapport form, paper
    // Erfassungsblatt, milestone webhook matching, stats export). `id` should equal the
    // sender's device name (Traccar convention). Empty = every vehicle-times surface hidden.
    "vehicles": [],                               // e.g. { "id": "tlf", "label": "TLF", "winfapAlias": "TLF" }
    // Data-driven Auswahl-Vorschläge: each entry attaches a suggestion list to one symbol
    // field. `field` is "title" (the symbol's title combobox) or a detail-row key (e.g. "Typ",
    // "Einheit"). Free typing in the Lage always stays possible – these only prefill. Edit in
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
    "funkkanalMin": 1, "funkkanalMax": 9999,
    "alarmBar": 100,                              // pressure alarm threshold (bar). ONE tier
                                                  // by design – the older 60-bar «Mindestdruck»
                                                  // second tier was dropped 2026-07-27
    "contactIntervalMin": 5,                      // SCBA contact interval – "Kontakt fällig" (amber)
    "contactGraceSec": 60,                        // Nachfrist after the interval before the überfällig alarm
    "defaultPressureBar": 300, "pressureStep": 10, "pressureMax": 320
  },

  "roster": {
    "source": "manual"                            // "divera" | "manual" (CSV/hand) |
                                                  // "snapshot" (a published roster file) – see §4
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
    "sources": [                                  // where a Mittel was drawn from – optional per entry,
      { "id": "tlf",     "label": "TLF" },        // typically the vehicles + the depot. The picker
      { "id": "pio",     "label": "Pio" },        // offers exactly this list (no free-typed sources).
      { "id": "magazin", "label": "Magazin" }     // `stock[].source` references these ids.
    ],
    "units": ["Stk", "l", "Sack", "Flasche", "Dose"]  // unit suggestions for custom entries; free text always ok
  },

  "alarms": {                                    // alarm auto-archive + intake extras
                                                  // NOTE: auto-open is no longer a setting – every alarm
                                                  // opens its Einsatz on arrival, on every path. The old
                                                  // "autoOpen"/"autoOpenPriorities"/"autoOpenKeywords"
                                                  // keys are still ACCEPTED and IGNORED (dropped in the
                                                  // next MAJOR); what they used to buy – test alarms and
                                                  // Nachbarhilfe not being counted – is now the stats
                                                  // export's editor_opened_at filter, docs/STATS-EXPORT.md
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

  "alarmKeywords": null,                         // the station's OWN alarm vocabulary – see §1a.
                                                 // admin sessions only; withheld from anonymous GET.
                                                  // null / omitted (normal) = the vocabulary shipped
                                                  // in backend/app/data/alarm_keywords.json

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

## 1a. `alarmKeywords` – the station's own alarm vocabulary

Incoming alarms are classified from the words in their title: a **damage category** (the FKS
Schadenkategorie stored on the incident) and a **priority** (`HIGH` wakes everyone; everything
else is `LOW`). The words that do that are German fire-service words – `FEUER`, `VU`,
`MED USTÜ` – and they ship with the app in
[`backend/app/data/alarm_keywords.json`](../backend/app/data/alarm_keywords.json). **Nearly
every station should leave this alone.** The file is not vendor-specific: it is what a Swiss
brigade's dispatch text looks like, whoever delivers it.

Set `alarmKeywords` when that is not what *your* dispatch text looks like – another language,
another Stichwort set, another alerting system.

**It replaces the shipped vocabulary wholesale.** There is no per-keyword merging: the moment
you set it, your block is the entire vocabulary and the shipped words are gone for this
deployment. That is deliberate. Two half-vocabularies that combine somewhere are impossible to
read at 3am, and «which keywords are running» has to have one answer in one place. **So to add
a single keyword, copy the shipped file, add your line to the copy, and paste the whole thing
in** – the file is the starting point, not a base to patch.

```jsonc
"alarmKeywords": {
  "schema_version": 1,                            // the shape this block was written against
  "keyword_to_category": {
    "pairs": [                                    // ORDERED: first keyword found in the
      ["INCENDIE", "brandbekaempfung"],           // uppercased title wins. Keywords must be
      ["ACCIDENT", "strassenrettung"]             // UPPERCASE – matching uppercases the title
    ]
  },
  "fallback_category": "diverse_einsaetze",       // used when nothing matches
  "high_priority_keywords": {
    "groups": [                                   // any match in title+text ⇒ HIGH. The grouping
      { "group": "Feu",                           // is for the reader; order means nothing here.
        "keywords": ["INCENDIE", "FUMÉE"] }       // Only life-threatening words belong here.
    ]
  }
}
```

Categories are **keys, not labels**: they must be ones the app has a German label for –
`brandbekaempfung`, `elementarereignis`, `strassenrettung`, `technische_hilfeleistung`,
`oelwehr`, `chemiewehr`, `strahlenwehr`, `einsatz_bahnanlagen`, `bma_unechte_alarme`,
`dienstleistungen`, `gerettete_tiere`, `diverse_einsaetze`. A vocabulary routing anywhere else
is rejected, because those alarms would silently file under «Diverse Einsätze».

> **An invalid block fails the load; it is never ignored.** `admin_config validate|load` and
> `PUT /api/config` refuse the whole document and write nothing – a lowercase keyword (dead
> data that would never fire), a duplicate keyword (the later one unreachable), an empty list,
> an unknown category, a `schema_version` this build does not understand. A vocabulary that was
> quietly dropped would classify alarms wrongly and say nothing, and you would find out from an
> alarm that did not wake anybody.

**Checking which vocabulary is running**, without opening the database:

```bash
curl -s http://localhost:8001/api/config | jq .alarmVocabulary
# { "source": "shipped", "schemaVersion": 1, "titleKeywords": 19,
#   "highPriorityKeywords": 41, "fallbackCategory": "diverse_einsaetze" }
```

`source` is `"shipped"` or `"deployment"`. `validate`, `diff` and `load` print the same line.
A saved change is live on the next alarm (the resolved vocabulary is cached for at most a
minute, and a `PUT` clears the cache immediately).

Two things this does **not** reach: the *matcher* (kp-front matches every keyword as a plain
substring – the shipped file records where kp-rueck differs) and the German category **labels**,
which are the app's, not the station's. And `alarmKeywords` is deployment data: unlike the
shipped file it is never checksummed and never compared against kp-rueck.

**Who can read it back.** `GET /api/config` is public – the login screen needs branding before
anyone can log in – and `alarmKeywords` is the one section withheld from anonymous callers. The
words are not secret (the shipped vocabulary is on GitHub), but nothing in the frontend reads
them: matching is entirely server-side, so publishing a station's wording pre-login would be
surface for nothing. An **admin session gets the full block**, which is not a detail: the admin
UI does a full-document `PUT`, so a section the admin never received is a section the next
unrelated edit would silently delete.

What stays public either way is the `alarmVocabulary` **summary** – `source`
(`shipped` | `deployment`), `schemaVersion` and counts, never the words – so "is my override
live?" is answerable without a session. The CLI is unaffected: `admin_config` reads the
database directly rather than through the API.

---

## 2. Reference / werkleitungs layers – **station-supplied, nothing bundled**

No layers ship with the app except the swisstopo/OSM base maps (§7). Every operational
reference layer (hydrant, water/gas/electricity mains, hazard zones) is entered by the station.
Two kinds, mirroring the existing `LayerDef`:

### 2a. Raster layer (WMS / WMTS) – *paste a URL template*
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

### 2b. Vector layer (GeoJSON) – *for points/lines you own*
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

`autoActivate` (also valid on raster layers) names the **Einsatz categories** – the German
VKF `kategorien` values (`Brandbekämpfung`, `Elementarereignis`, `Ölwehr`, …) – for which the
layer switches itself visible: when an incident of that category is opened for the first time,
and additively when an incident is later re-categorized (a BMA that turns out to be a real
fire brings the hydrants up). It only ever turns layers **on**, and once the operator has
toggled layers in an incident their choice is authoritative – a deliberately hidden layer is
not re-forced on reopen. Unset = the layer never auto-activates (the default).
You don't write the `geojson` URL by hand: load the file with the **`admin_geodata` CLI**
(§9c) from a *manifest* – a layer entry plus a `file:` pointing at the GeoJSON. The CLI puts
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
| Logo | SVG (preferred) or PNG | shown in login/header **and above the title on the printed Einsatzrapport**; transparent background |
| App icon | PNG **192×192** and **512×512** | PWA / home-screen |
| Favicon | SVG or ICO | browser tab |

### 3b. Hydrants – GeoJSON
- **Type:** `FeatureCollection` of `Point` features.
- **CRS:** **WGS84 (EPSG:4326), `[lng, lat]`** – per RFC 7946. The app does **not** reproject;
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

### 3c. Plans (object plans) – PDF
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
  (`/api/reference/objects`); a station with no object data simply has no object plans – the
  `osm` and `tafel` sheets still work.

---

## 4. Roster / personnel

`roster.source` selects how `Person` records are populated.

### 4a. `"divera"` – auto-sync
- Requires a Divera access key in env (§6). The backend syncs Divera personnel → `Person`.
- No file needed. The admin UI shows the synced roster and offers preview-then-execute sync; it
  is **not** locked – hand entry and CSV import keep working, and a sync never wipes a rank an
  admin set. Synced people carry a `divera` external identity, which is what the sync reconciles
  on; people you added by hand have none and are left alone.

### 4b. `"manual"` – CSV import + hand entry
- Admin imports a CSV and/or adds people in the UI. **CSV columns:**
  | column | required | meaning |
  |--------|----------|---------|
  | `name` | ✅ | display name ("Meier Anna") |
  | `rank` | – | Dienstgrad, matched case/accent-insensitively against `roster.ranks` `key`/`label`/`abbr`; an unknown value imports the person **without** a rank and is reported back in the import result rather than failing the row |
  | `provider` | – | provider key an external identity is filed under (`personnel_external_identities.provider`) |
  | `external_id` | – | that provider's id for this person; required whenever `provider` is given |
  | `divera_id` | – | legacy spelling of `provider=divera` + `external_id`, accepted during the compatibility window – prefer the two columns above |
- Encoding UTF-8, comma-separated, header row required. Extra columns ignored. A row carrying a
  `provider`/`external_id` pair already known **updates** that person; everything else is added.
- The admin UI's «Beispiel-CSV herunterladen» button writes the minimal form (`name,rank`).

### 4c. `"snapshot"` – a roster file somebody else publishes

> **Status: contract only.** The schema, the example and the validator below are shipped and
> versioned; **the ingestion is not built.** A deployment set to `"snapshot"` today behaves
> exactly like `"manual"` – CSV and hand entry work, nothing is fetched, nothing is synced. The
> contract is published first on purpose, so that what stations produce is designed rather than
> whatever the first importer happened to need.

Some stations keep their personnel list somewhere else entirely – a municipal HR system, a
cantonal register, a sibling application, a nightly script. `"snapshot"` is for exactly that
case: **that system publishes a JSON file to a URL, and this deployment reads it.** It is one
personnel provider among several. It is selectable, it is disconnectable, and it is never
required – disconnecting it leaves every local person exactly where they were, because local
personnel are canonical and a provider only attaches identity and provenance.

Nothing about a particular publisher is built into the app: any URL a deployment can read
works, and the schema names no vendor.

- **Contract:** [`roster-snapshot.schema.json`](roster-snapshot.schema.json) (JSON Schema).
- **Worked example:** `backend/roster.snapshot.example.json`.
- **Validate a file you produced** – no database, no network, no deployment needed:
  ```bash
  cd backend && uv run python -m app.roster_snapshot validate my-roster.json
  # OK: complete snapshot from 'musterdorf-personalstamm', 4 people (3 active), …
  ```
  `schema`, `outcome-schema` and `example` print the contract and a starting point.

**The document:**

| field | required | meaning |
|-------|----------|---------|
| `schema` | ✅ | `"roster-snapshot/1"` – the contract this file is written to |
| `schema_version` | ✅ | `1`. A consumer that does not know the version refuses the file rather than guessing |
| `generated_at` | ✅ | RFC 3339 **with offset**, when the publisher built the file. A consumer shows the age and warns when it stops moving – a feed that silently froze is the failure a puller cannot see from the inside |
| `provider` | ✅ | the key identities from this file are filed under (`^[a-z][a-z0-9_-]{1,31}$`, ≤32 chars). One station may read two snapshots; this is what keeps them apart |
| `complete` | ✅ | `true` = a statement about **everyone**, so a local person carrying this provider's identity and absent from the file has left and may be **deactivated** (never deleted – old Einsätze keep resolving the name). `false` = says nothing about absence, and a consumer must not act on it |
| `count` | ✅ | restated by the publisher and checked against `people`. A truncated upload must never read as "most of the brigade left" |
| `people` | ✅ | at least one. A file listing nobody is a broken publish, not an empty brigade |

**One person:**

| field | required | meaning |
|-------|----------|---------|
| `external_id` | ✅ | the publisher's own stable key, ≤255 chars. The only thing a consumer may match on without guessing – names change, keys must not |
| `display_name` | ✅ | how the person appears in a picker ("Meier Anna") |
| `first_name`, `last_name` | – | when the publisher holds them split |
| `rank` | – | a **key** from this station's `roster.ranks` (§1), never a label – the publisher does not have to know how you spell "Wachtmeister". A key you do not define imports the person without a rank and is reported |
| `active` | – | default `true`. `false` = on file, no longer operational |
| `identities` | – | up to 8 `{ "provider": …, "external_id": … }` pairs – the same person's id in *other* systems, landing in `personnel_external_identities` |

`identities` is how a snapshot says "the person this file calls `pers-0001` is the one your
alerting system calls 4711" **without either product growing a column named after a vendor**.
There is deliberately no `divera_id`-shaped field: vendor columns are deprecated here and in
KP Rück, and a contract that named one alerting system would be wrong for every station using a
different one.

#### 🔴 No medical fields, ever

A personnel file is where Arztuntersuchungs-Termine, Tauglichkeiten, Impfungen and absences
live in most fire-service systems. **None of them may appear in a roster snapshot**, and that
is not a request: `parse_snapshot` scans every key of an incoming document and **refuses the
whole file** – naming the key and the reason – if one looks medical, in German, English, French
or Italian. The same check runs over the schema itself in CI, so the guarantee survives future
edits of the contract rather than depending on whoever reviews them.

That is also why the document carries **no free-form `metadata` map and no `qualifications`
list**. A string map's keys are data, so no schema can see inside it, and a raw qualification
list is precisely where "Atemschutz-Tauglichkeit bis 2027" would arrive wearing a name no check
can object to. `rank` is the derived, non-medical projection the app actually uses.

Honest limit: the check reads *names*. Nothing stops a publisher writing medical information
into `display_name`. Do not.

#### What a consumer has to be able to say afterwards

A roster that quietly loses people corrupts every attendance figure derived from it, invisibly.
So the shape of the answer is fixed before anything implements the question:
[`roster-snapshot-outcome.schema.json`](roster-snapshot-outcome.schema.json) is the report one
ingestion run must be able to produce – `matched` / `created` / `updated` / `deactivated`,
every person it **could not place** with the reason (`no_identity_match`, `ambiguous_name`,
`conflicting_identity`, `absent_from_snapshot`, `inactive_in_snapshot`), every `rank` key it did
not recognise, and `refused` for "I changed nothing, and here is why". **Unmapped people are
counted and flagged, never silently dropped.**

#### Versioning

`schema` and `schema_version` are bumped only when the *shape* changes. The two schema files are
generated from `backend/app/roster_snapshot.py` by `just roster-schema`; a test fails when the
committed copies drift from the code (the same arrangement [`openapi.json`](openapi.json) has),
and a second test pins their checksums because KP Rück holds byte-identical copies – editing the
contract is a two-repository change.

> Whichever source is set, the **app stays usable with an empty roster** – every person picker
> (Einsatzleiter, Fahrer, Trupp names) offers free-typing, so a station can run before importing
> anyone (§8). And `roster.source` is a *preference*, not a lock: CSV import and hand entry
> remain available on every setting.

---

## 5. User accounts, roles, and deployment administration

Not part of `deployment_config` – operational users are managed separately from station config.
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
  admin surface is disabled (every admin endpoint returns 403) – it never falls back to the editor
  PIN. Use it for config/user maintenance, not for 3am incident work.
- **Account source of truth:** preferably config/CLI/seed file for deployers, with the admin UI
  for inspection, PIN reset, deactivation, and simple changes. **PIN reset is admin-driven** (no
  email recovery).

---

## 6. Environment variables (secrets / infra – operator, not admin)

Set at deploy time; never editable from the UI, never in the repo.

| Env var | Purpose |
|---------|---------|
| `DATABASE_URL` | Postgres connection (`postgresql://…`; auto-upgraded to asyncpg) |
| `SECRET_KEY` | JWT signing + PIN pepper (≥32 chars; **required in prod**) |
| `ADMIN_SECRET` | unlocks the `/admin` UI + admin-write API/CLI, separate from the editor PIN (≥16 chars; empty = admin disabled, fail-closed) |
| `MEDIA_STORAGE_DIR` | local asset/media dir (default `data/storage`) |
| `S3_*` | optional: bucket/endpoint/keys if using object storage |
| `DIVERA_ACCESS_KEY`, `DIVERA_WEBHOOK_SECRET` | if `diveraEnabled` |
| `ALARM_WEBHOOK_SECRET` | generic alarm intake `POST /api/alarms` for non-Divera alerting systems – auto-opens an incident per alarm, idempotent on `source`+`source_id` (empty = endpoint disabled, fail-closed) |

> **Erfassungs-Poster (station capture):** not an env var – the poster token lives in the DB and is
> managed in the admin UI (Personen › Erfassung): activate/rotate/disable, print the A4 poster.
> Scanning it opens `/e/<token>`, where attendance/material/notes for incidents of the last
> `alarms.captureWindowHours` are recorded without a login. Fail-closed: no token → the whole
> `/api/capture/*` surface answers 403. Rotation invalidates every printed poster at once. |

> **Statistik-Export:** also DB-stored, managed in the admin UI (Datenquellen › Statistik-Export).
> `GET /api/stats/incidents?year=` returns one flat read-only JSON record per incident (metadata,
> Zeiten, Anwesenheit von–bis, Mittel totals, Rapport status) for external analytics – auth via
> `X-Stats-Token` header or `?t=`. Fail-closed: no token → 403. Full field reference:
> `docs/STATS-EXPORT.md`. |

> **Einsatz-Link (read-only link into one incident):** also not an env var – the station's
> `incident_link_key` lives in the DB and is managed in the admin UI: show it, rotate it, delete
> it. Copy it into the alerting system, which signs a token with it and puts `/l/<token>` into
> the alert it sends out; a responder taps that on a personal phone and sees **one** incident
> the way a `viewer` does – no login, nothing that writes, prints or costs money – for as long
> as the Einsatz is running: closing or archiving it revokes every open link at once (12 h is
> the backstop for the one nobody closes). Fail-closed: no key → the link surface answers 403
> and nothing exists, which is also what every existing deployment gets from the migration.
> Rotation or deletion invalidates every link already sent out and requires reconfiguring the
> alerting system. Trust model and reachable surface: `docs/ALARM-INTEGRATIONS.md` §4. |

> **Objektplan-Pull (fetch Modul-PDFs instead of having them pushed in):** a station whose plan
> library is maintained elsewhere can publish it to an **S3-compatible bucket** and let the
> deployment fetch from there on a schedule, instead of giving that system an `ADMIN_SECRET` –
> a credential for the entire admin API – so it can push. The bucket holds
> `plans/index.json` (object id, module, filename, size, **sha256**, address – metadata, never
> bytes) and `plans/<object-id>/<module>.pdf`; only a checksum that actually changed is
> downloaded, and it lands as the same `plan:<obj>:<module>` dataset a manual upload writes.
> Any S3-compatible store works – MinIO, Backblaze B2, a hosted bucket, AWS – and a **read-only**
> key is enough; nothing about a provider is built into the app. `PLANS_S3_PREFIX` is optional,
> `PLANS_S3_REGION` is whatever your provider's docs say verbatim. Existing plans are **never
> deleted** by a pull, and a malformed or incomplete index refuses the whole run rather than
> ingesting half of it. Fail-closed: no endpoint/bucket/key/secret → no job is scheduled, nothing
> is fetched, and plans stay exactly as they were loaded. Index format and the reasoning:
> `docs/objektplaene-architecture.md`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push for killed-app alarms + new-alarm push (generate once: `cd backend && uv run python -m app.gen_vapid`; empty = push disabled, fail-closed) |
| `PRINT_AGENT_SECRET` | station print relay: «An Stationsdrucker» queues the Einsatzrapport-PDF for an on-site agent (any always-on box with a CUPS queue). The agent now serves KP Front *and* KP Rück from one install – see [`tools/PRINT-AGENT.md`](../tools/PRINT-AGENT.md); the endpoint contract below is unchanged. Empty = agent endpoints 403 and the button never renders, fail-closed. |
| `HEALTHCHECK_PING_URL` | dead-man's switch: a 60 s job GETs this URL (healthchecks.io or any cron monitor), so the monitor alerts when the pings *stop*. Catches the class an HTTP probe of `/ready` cannot: a container stopped with nothing replacing it, or a wedged event loop. Point it at a check with a 1 min period and ~3 min grace. Empty = the job is never scheduled; a failed ping is logged and swallowed, so a monitoring outage never disturbs the deployment. |
| `TRACCAR_URL`, `TRACCAR_EMAIL`, `TRACCAR_PASSWORD` | if `traccarEnabled` |
| `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`, `STT_LANGUAGE` | speech-to-text for the audio player's Transkribieren (OpenAI-compatible `/v1/audio/transcriptions`; base URL without `/v1` – Groq: `https://api.groq.com/openai`, OpenAI: `https://api.openai.com`, or a self-hosted faster-whisper server). Empty base URL = off, fail-closed. **Audio is sent to that server** – prefer self-hosted for sensitive deployments. |
| `PLANS_S3_ENDPOINT`, `PLANS_S3_BUCKET`, `PLANS_S3_PREFIX`, `PLANS_S3_REGION`, `PLANS_S3_ACCESS_KEY_ID`, `PLANS_S3_SECRET_ACCESS_KEY`, `PLANS_PULL_INTERVAL_MINUTES` | Objektplan-Pull – see the Objektplan-Pull callout in this section (empty endpoint = no pull, fail-closed) |
| `MAX_UPLOAD_MB` | request-body cap for multipart uploads (default 110 – must stay above the media endpoint's 100 MB per-file cap) |
| `GEOCODER_URL` | address-autocomplete endpoint (default the swisstopo SearchServer – see the caveat below) |
| `SEED_DATABASE`, `DEV_CREATE_ALL` | dev seeding / auto-create tables (prod uses Alembic) |
| `SEED_PIN` | **Required in production** when `SEED_DATABASE` is on: the six-digit PIN the seeded account gets. The seed file's own PIN is public, so the backend refuses to boot without this rather than create a login anyone knows. |

Weather (MeteoSwiss/Open-Meteo) and the swisstopo geocoder need **no** credentials – public
endpoints, national, work everywhere *in Switzerland*. One honest limitation: the geocoder
client speaks the swisstopo SearchServer API shape only, so outside Switzerland address
autocomplete simply returns nothing (map-pick still works). `GEOCODER_URL` exists to point at
a *compatible* endpoint (e.g. a proxy) – it is **not** a generic-geocoder swap point for
Nominatim/Google/etc.

---

## 7. What ships with the app (no config needed)

- **Base maps:** swisstopo (farbig/grau/SWISSIMAGE via WMTS), OpenStreetMap, Carto (incl. the
  night theme), Esri/OpenTopo. National coverage, day one.
- **FKS symbol set:** the KP-Front-authored library (`public/tactical-symbols.json`, generated
  by `tools/gen_symbols.py`) + presets + display names. **Not station-editable** – keeps
  stations interoperable.
- **Weather/wind, geocoder:** national public services.
- **Alarm keyword vocabulary:** the German fire-service words that turn an alarm title into a
  category and a priority (`backend/app/data/alarm_keywords.json`). Station-overridable, but
  only if your dispatch text is genuinely different – see §1a.

## 8. Empty state (a brand-new deployment)

A deployment with an empty config must be fully operable:
- swisstopo base map, centered on a neutral default until `map.defaultView` is set;
- no reference layers, no hydrants, no plans, no roster – and **nothing errors**;
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
data repo and loads them with `backend/app/admin_geodata.py` – the GeoJSON goes into the
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
deployment – or push the files through the in-app **Datenquellen** upload (which goes via the
API to the server's store). From a workstation against a remote DB, use **`load --config-only`**
(inject `DATABASE_PUBLIC_URL`, like `admin_config`): it writes just `referenceLayers` and never
touches files, so it can't point rows at GeoJSON that isn't on the server.

## 9d. Loading checklists (`admin_checklists`)

Checklist templates (the FU action list, the Lagerapport agenda, the EL tactical playbook) are
station data too: one `ChecklistTemplate` JSON per list – plus playbook diagram images for
`reference` templates – and a `checklists.manifest.json`, kept in the private data repo and
loaded with `backend/app/admin_checklists.py`. Each template becomes a `checklists:<id>`
reference dataset (diagram pages as `checklists:<id>:p<N>`), served at
`/api/reference/checklists:<id>` and fetched + offline-cached by the Checkliste surface
(`loadTemplates` in `src/lib/checklists.ts`). With nothing loaded, the app falls back to one
neutral bundled example (`src/data/checklists/generic-action.json`) – never a station's real
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
server writes its own volume – the way to refresh a remote deployment from a workstation.

## 9e. Wartungswerkzeuge (`reset_roster`, `demo_export`)

Zwei weitere CLIs, die keiner Station begegnen, aber jemandem, der ein Deployment betreut.
Sie standen bisher nur in ihren eigenen Docstrings, was sie beim Aufräumen zweimal fast das
Leben gekostet hat — ein Modul, das nichts importiert und kein Dokument erwähnt, sieht wie
toter Code aus.

**`reset_roster` — die Benutzerliste auf die Seed-Datei zurücksetzen.**
Anders als `seed.py`, das nur fehlende Benutzer anlegt und bestehende PINs nie anfasst, setzt
dieses Werkzeug *durch*: es aktualisiert jeden Benutzer aus der Seed-Datei (Anzeigename, Rolle,
Farbe **und** PIN) und deaktiviert jeden, der nicht darin steht. Deaktiviert, nicht gelöscht —
Fremdschlüssel auf Einsätze, Notizen und Medien bleiben heil, und die Mannschaftsliste zeigt
trotzdem nur die geseedeten.

```bash
# from backend/ — mit SECRET_KEY (dem PIN-Pfeffer) und DATABASE_URL der ZIELumgebung
SECRET_KEY=<ziel> DATABASE_URL=<ziel-public> uv run python -m app.reset_roster
```

Der `SECRET_KEY` ist nicht optional: er pfeffert die PIN-Hashes. Mit dem falschen kommt eine
Liste heraus, in die sich niemand einloggen kann.

**`demo_export` — die Demo-Szene zurück in die Seed-Datei schreiben.**
Die öffentliche Demo behält Änderungen über den Tag. Wer die vorplatzierten Symbole,
Schlauchleitungen oder das Gebäude neu anordnen will, tut das live in der App und bäckt das
Ergebnis anschliessend in `examples/demo-data/incident.workspace.json`:

```bash
DATABASE_URL=<demo Postgres public URL> uv run python -m app.demo_export
```

Liest nur; das Einzige, was geschrieben wird, ist die Repo-Datei. Behalten werden die von Hand
gesetzten Schlüssel (`entities`, `drawings`, `building`, `board`, `layerState`, `recent`) — die
Sammlungen, die der nächtliche Reset ohnehin neu anlegt (`trupps`, `mittel`, `attendance` …),
fallen weg, damit sie nicht in den Seed einfrieren. Ergebnis committen, der nächtliche Reset
zieht daraus.

## 9. Out of scope for this doc
- **Device preferences** (theme day/night/auto, symbol size) – per-device cookie, not synced.
- **Per-incident settings** (`IncidentSettings`: `contactIntervalMin`, `contactGraceSec`,
  `defaultFunkkanal`) – live in the workspace blob, default from `doctrine` above.
