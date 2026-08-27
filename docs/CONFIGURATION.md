# CONFIGURATION – what a station must provide, and in what format

**Status:** Live configuration contract. The Tier-2 config layer is implemented as a DB-backed
`deployment_config` document. **Two doors write it and they write the same rows:** forms at
`/admin`, which is where a station normally administers itself, and the CLI/config-file
tooling, which is the same document as a file – for config you want reviewed, versioned or
reproduced on a second deployment.

This document is the **data contract** every other piece builds on: what a station keeps in its
private config/data repo, what the CLI validates and loads, what the admin UI visualizes, and what
the backend validates.

**In a hurry?** Setting a station up for the first time: [§9](#9-loading-station-data-with-the-admin-clis)
is the load order and the five CLIs. Looking for an environment variable:
[§6](#6-environment-variables-secrets--infra--operator-not-admin). Looking for a field of the
config JSON: [§1](#1-deployment-config-the-json-the-deployment-owner-edits).

## Contents

- [0. The four layers (recap)](#0-the-four-layers-recap)
- [1. Deployment config – the JSON document](#1-deployment-config-the-json-the-deployment-owner-edits)
  - [Where each section is edited](#where-each-section-is-edited)
  - [1a. `alarmKeywords` – the station's own alarm vocabulary](#1a-alarmkeywords--the-stations-own-alarm-vocabulary)
  - [1b. `report.hoursRounding` – Einsatzstunden on the printed rapport](#1b-reporthoursrounding--einsatzstunden-on-the-printed-rapport)
  - [1c. `report.attendanceMergeGapMin` – two ticks that are one arrival](#1c-reportattendancemergegapmin--two-ticks-that-are-one-arrival)
  - [1d. `report.links` – the station's own forms, on the Rapport](#1d-reportlinks--the-stations-own-forms-on-the-rapport)
- [2. Reference / Werkleitungs layers – station-supplied](#2-reference--werkleitungs-layers--station-supplied-nothing-bundled)
  - [2a. Raster layer (WMS / WMTS)](#2a-raster-layer-wms--wmts--paste-a-url-template) ·
    [2b. Vector layer (GeoJSON)](#2b-vector-layer-geojson--for-pointslines-you-own)
- [3. Uploaded assets & their formats](#3-uploaded-assets--their-formats)
  - [3a. Branding](#3a-branding) · [3b. Hydrants – GeoJSON](#3b-hydrants--geojson) ·
    [3c. Plans (object plans) – PDF](#3c-plans-object-plans--pdf)
- [4. Roster / personnel](#4-roster--personnel)
  - [4a. `"divera"`](#4a-divera--auto-sync) · [4b. `"manual"`](#4b-manual--csv-import--hand-entry) ·
    [4c. `"snapshot"` – the roster-snapshot contract](#4c-snapshot--a-roster-file-somebody-else-publishes)
- [5. User accounts, roles, and deployment administration](#5-user-accounts-roles-and-deployment-administration)
- [6. Environment variables (secrets / infra)](#6-environment-variables-secrets--infra--operator-not-admin)
  - [The seventeen integration credentials – env **or** `/admin`](#the-seventeen-integration-credentials--env-or-admin--zugangsdaten)
  - [6a. Objektplan-Pull](#6a-objektplan-pull-fetch-modul-pdfs-instead-of-having-them-pushed-in)
  - [6b. Three things that look like env vars and are not](#6b-three-things-that-look-like-env-vars-and-are-not)
- [7. What ships with the app (no config needed)](#7-what-ships-with-the-app-no-config-needed)
- [8. Empty state (a brand-new deployment)](#8-empty-state-a-brand-new-deployment)
- [9. Loading station data with the admin CLIs](#9-loading-station-data-with-the-admin-clis)
  - [9a. What all of them share (`load` vs `push`, the order)](#9a-what-all-of-them-share)
  - [9b. `admin_config` – the deployment config](#9b-admin_config--the-deployment-config)
  - [9c. `admin_branding` – the five branding slots](#9c-admin_branding--the-five-branding-slots)
  - [9d. `admin_geodata` – reference layers](#9d-admin_geodata--reference-layers)
  - [9e. `admin_objects` – Einsatzobjekte + Modul-PDFs](#9e-admin_objects--einsatzobjekte--modul-pdfs)
  - [9f. `admin_checklists` – checklist templates](#9f-admin_checklists--checklist-templates)
  - [9g. Maintenance tools (`reset_roster`, `demo_export`)](#9g-maintenance-tools-reset_roster-demo_export)
  - [9h. The station workbook – one `.xlsx` for the list-shaped data](#9h-the-station-workbook--one-xlsx-for-the-list-shaped-data)
- [10. Out of scope for this doc](#10-out-of-scope-for-this-doc)

> **Section numbers are stable.** §1–§8 keep the numbers other documents and code comments
> already cite. The CLI sections were renumbered once (2026-08-16) into the order you run them:
> the old §9b/§9c/§9d/§9e are now §9b/§9d/§9f/§9g.

---

## 0. The four layers (recap)

| Layer | What | Where | Editable by |
|-------|------|-------|-------------|
| **Defaults** | National/safe fallbacks (FKS doctrine, symbol presets) | `src/config/appConfig.ts` | developers |
| **Deployment config** ← *this doc* | Per-station settings + uploaded assets | DB `deployment_config` row + asset storage | technical deployment owner – forms at `/admin`, or the same rows as a config file via CLI |
| **Secrets / infra** | DB URL, API keys, session secret | environment variables, **or** – for the seventeen integration credentials – the encrypted `integration_credentials` table | operator (deploy time) · an **admin** at `/admin` → Zugangsdaten for those seventeen. **Env wins and locks the field** (§6) |
| **Per-incident settings** | Live operational knobs (synced) | workspace blob (`IncidentSettings`) | any **user**, in-incident |

**Resolution:** per-incident overrides deployment config overrides defaults. **An empty
deployment config is valid** – the app must run as a generic, empty station (see `§8 Empty
state`).

---

## 1. Deployment config (the JSON the deployment owner edits)

One JSON document, stored as the single `deployment_config` row, returned by `GET /api/config`.
**Every field is optional**; anything omitted falls back to the national default.

### Where each section is edited

**The browser is the primary path for nearly all of it.** The `admin_*` CLIs (§9) write the same
rows and are not deprecated – they are the config-as-code route, for a setup you want reviewed,
versioned and reproducible on a second deployment. This table is the answer to "do I need a file
for this?"; the German names are the pages in the left-hand `/admin` nav.

| Section | Browser | Where |
|---------|---------|-------|
| `identity.*` (`appName`, `locale`, `accentColor`, `helpIntro`, `kommandant`) | ✅ | Station › **Station & Karte** |
| `identity.assets` | ✅ | the branding uploads – **not** part of this document (see the ⚠️ below and §3a) |
| `map.defaultView`, `map.geocoder.*` | ✅ | Station › **Station & Karte** |
| `map.externalLinks` | ✅ | Station › **Station & Karte** – ⚠️ editable, but as shipped its only renderer is the field app's «Datenquellen» panel, which is **unreachable**. Configuring it changes nothing anybody can see today |
| `referenceLayers` – raster (WMS/WMTS) and GeoJSON, incl. the file upload | ✅ | Station › **Kartenebenen** (§2) |
| `referenceLayers[].nightColor` · `.opacity` · `.maxzoom` · `.symbol` · `.autoActivate` | ❌ | file only – the forms **merge** over the stored row, so a CLI-set value survives an edit |
| `modules` (the Objektplan-Modul catalogue) | ❌ | **file only** – the Objektpläne page lists the catalogue read-only; the objects and their PDFs are what you edit there ([`objektplaene-architecture.md`](objektplaene-architecture.md)) |
| `doctrine.*` | ✅ | Station › **Doktrin** |
| `journal.*` | ✅ | Station › **Journal** |
| `report.hoursRounding`, `.attendanceMergeGapMin`, `.reversePrintOrder`, `.links` | ✅ | Station › **Rapport** (§1b–§1d) |
| `report.partnerOrgs` | ✅ | Station › **Rapport** – **and** the Arbeitsmappe (§9h) |
| `alarms.autoArchiveDays`, `.staleIncidentDays`, `.captureWindowHours`, `.webhooks`, `.groups` | ✅ | Station › **Alarme & Einsätze** |
| `alarms.groups[].winfapAlias` · `.tagespikett` | ❌ | dead fields – see the note under `alarms` below |
| `fleet.vehicles` | ✅ | Station › **Fahrzeuge & Symbole** – **and** the Arbeitsmappe (§9h) |
| `fleet.attributeLists` | ✅ | the Arbeitsmappe's «Symbolfelder» sheet (§9h) – ⚠️ **not** the «Fahrzeuge & Symbole» page: the table there is a viewer with no editor |
| `fleet.partner.*` | ✅ | the Arbeitsmappe only (§9h) – ⚠️ it is the **legacy** shape, see the caveat in §9h |
| `mittel.catalogue`, `mittel.sources` (incl. `catalogue[].stock`) | ✅ | the Arbeitsmappe only (§9h) |
| `mittel.catalogue[].when`, `fleet.vehicles[].winfapAlias` | ❌ | **preserved but not editable** through the Arbeitsmappe (§9h); a file is the only way to set them |
| `roster.nameOrder` | ✅ | Personen › **Personal** (§4) |
| `roster.source` | ❌ | **file only** – «Personal» edits the crew and the name order, never where the crew comes from ([`SETUP.md` §4](SETUP.md)) |
| `roster.ranks` | ✅ | the CSV import's «Grade zuordnen» → `adopt` (§4b) – **and** the Arbeitsmappe (§9h). There is no rank *form* |
| `mittel.units` | ❌ | **file only** – the Arbeitsmappe does not carry it |
| `alarmKeywords` | ❌ | **file only** – it is a paste-a-document, not a fill-a-form (§1a) |

Two things that are **not** part of this document and are managed on their own pages: the
integration credentials (`/admin` → **Zugangsdaten**, §6) and the three database-stored tokens
in §6b. Einsatzobjekte + Modul-PDFs and checklist templates are not config paths either, and
both now have browser pages – §9e and §9f.

> ⚠️ **Every write replaces the WHOLE document.** There are no partial writes – the admin UI, the
> CLIs and the backup importer all upsert the complete row. Two consequences you have to know:
>
> 1. **`identity.assets` is not editable through this document.** The branding slots are written
>    by the upload endpoints (`POST` / `DELETE /api/branding/{slot}`) and by `admin_branding push`,
>    because the URLs behind them only exist once a blob has been stored. A `PUT` or a `load` that
>    omits or nulls them **carries the stored values over** instead of clearing them. Removing a
>    logo means `DELETE /api/branding/{slot}`.
> 2. **`PUT /api/config` requires optimistic concurrency from a browser.** `GET` returns an
>    opaque `version` (a hash of the stored document); send it back as `If-Match` and a write
>    against a document somebody else has changed since is refused with **409** instead of
>    silently winning. The Verwaltung does this on every autosave – without it, a browser tab left
>    open reverted a whole station's config on the next nudge of one unrelated field.
>
>    A request that looks like a browser (it carries `Sec-Fetch-Site` or `Origin`) and sends **no**
>    `If-Match` is refused with **428 Precondition Required** – reload the page and repeat the
>    edit. ⚠️ Merely making the header optional was not enough, and the demo was clobbered a
>    second time because of it: the guard then protects only tabs new enough to send the header,
>    and the tab that does the damage is by definition an old one. **A non-browser caller may
>    still omit it** – `admin_config load`, `admin_geodata` and `admin_branding` are deliberate
>    one-shot pushes by somebody at a terminal, and they send neither header.

```jsonc
{
  "identity": {
    "appName": "Feuerwehr Musterdorf",        // shown in title bar, login, help; default "KP Front"
    "locale": "de-CH",                          // "de-CH" today; "fr-CH" / "it-CH" later
    "accentColor": "#c4161c",                   // HEX ONLY (#rgb/#rgba/#rrggbb/#rrggbbaa, `#`
                                                //    optional on input, stored lowercase with it);
                                                //    anything else is refused with 422. Flows
                                                //    through the --accent token system AND becomes
                                                //    the manifest's hex-only `theme_color` (§14).
                                                //    A value stored BEFORE this rule is read as
                                                //    unset rather than refused, so an old row
                                                //    cannot lock a station out of /admin.
    "assets": {                                 // ⚠️ READ-ONLY here – written by the branding
                                                //    endpoints / `admin_branding`; see the note
                                                //    above and §3 for upload rules
      "logo": "logo.svg",                        // ref into asset storage
      "reportLogo": "report-logo.svg",           // letterhead; falls back to `logo` when unset
      "favicon": "favicon.svg",
      "iconPng192": "icon-192.png",              // installed-PWA home-screen icons, square PNG
      "iconPng512": "icon-512.png"
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
                                                 // (skipped once the operator types a locality
                                                 //  themselves – a PLZ, or anything after a
                                                 //  comma – and its town ranks hits first)
      "bboxLv95": "2598000,1252000,2625000,1270000"  // "minE,minN,maxE,maxN" to rank local hits; "" = national
    }
  },

  "referenceLayers": [ /* see §2 – entirely station-supplied, none bundled */ ],

  "fleet": {
    // Station vehicles for the Alarmierungs-/Ausrückzeiten grid (rapport form, paper
    // Erfassungsblatt, milestone webhook matching, stats export). `id` should equal the
    // sender's device name (Traccar convention). Empty = every vehicle-times surface hidden.
    // Edit on Verwaltung › Fahrzeuge & Symbole or on the «Fahrzeuge» sheet of the Arbeitsmappe
    // (§9h) – the latter carries `winfapAlias` over on an id match but cannot set it.
    "vehicles": [],                               // e.g. { "id": "tlf", "label": "TLF", "winfapAlias": "TLF" }
    // Data-driven Auswahl-Vorschläge: each entry attaches a suggestion list to one symbol
    // field. `field` is "title" (the symbol's title combobox) or a detail-row key (e.g. "Typ",
    // "Einheit"). Free typing in the Lage always stays possible – these only prefill. Edit on
    // the «Symbolfelder» sheet of the Arbeitsmappe (§9h) or in the config JSON via CLI.
    // ⚠️ Verwaltung › Fahrzeuge & Symbole only SHOWS them – that table has no editor.
    "attributeLists": [
      { "symbol": "VKF Fahrzeug",          "field": "title",   "options": ["TLF", "ADL", "HLF", "ELW"] },
      { "symbol": "VKF Luefter mobil",     "field": "Typ",     "options": ["Überdruck", "Elektro", "Akku"] },
      { "symbol": "FW Kleinloeschgeraet",  "field": "Typ",     "options": ["Wasser", "Schaum", "CO₂"] },
      { "symbol": "VKF Bereich Feuerwehr", "field": "Einheit", "options": ["Stützpunkt", "Nachbarwehr"] },
      { "symbol": "VKF Bereich Sanitaet",  "field": "Einheit", "options": ["Rettungsdienst", "Rega"] },
      { "symbol": "VKF Bereich Polizei",   "field": "Einheit", "options": ["Kantonspolizei"] },
      // what an Offizier on the Lage is DOING – the sector they were given, not their rank
      { "symbol": "FW Offizier",           "field": "Funktion",
        "options": ["Of-Front", "Lüften", "Atemschutz", "Retten", "Logistik"] }
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
    "defaultPressureBar": 300, "pressureStep": 10, "pressureMax": 320,
    "cylinderLiters": 7,                          // the two numbers behind the air estimate
    "estConsumptionLPerMin": 50                   // («noch ≈ N bar») on the Trupp card
  },

  "roster": {
    "source": "manual",                           // "divera" | "manual" (CSV/hand) |
                                                  // "snapshot" (a published roster file) – see §4
    "nameOrder": "last-first",                    // "last-first" (Meier Hans, default) |
                                                  // "first-last" (Hans Meier) – applies to every
                                                  // surface: lists, map tags, Rapport, print
    // The station's Dienstgrade, MOST SENIOR FIRST – the order here IS the seniority order.
    // `key` is what a CSV import and a roster snapshot match on (§4b, §4c); `abbr` is the short
    // badge in lists; `tier` drives the «nur Offiziere» picker filter and the Anwesenheit
    // grouping. Empty = the frontend's in-code Swiss default (`src/lib/rank.ts`). Edited on the
    // «Dienstgrade» sheet of the Arbeitsmappe (§9h) or by a CSV import's `adopt` (§4b) – there
    // is no rank form. A Dienstgrad somebody still carries cannot be dropped.
    "ranks": [
      { "key": "maj",  "label": "Major",        "abbr": "Maj", "tier": "officer" },
      { "key": "wm",   "label": "Wachtmeister", "abbr": "Wm",  "tier": "nco" },
      { "key": "sdt",  "label": "Soldat",       "abbr": "Sdt", "tier": "crew" }
    ]
  },

  "mittel": {                                    // material-use sheet (Mittel): billing/report + "brauchen wir mehr?"
    // Station catalogue of materials/equipment crews use up OR deploy (consumables like Ölbinder
    // AND reusable gear like Lüfter/Wärmebildkamera). `unit` seeds the entry's default unit
    // (editable per incident); `category` groups the picker + Bestand view; optional `stock` is
    // the nominal per-source load-out (→ used/available readout + the Bestand overview, where
    // sources omitted = none there). Anything not listed → type «Anderes Material» in-app.
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
    // `catalogue`, `catalogue[].stock` and `sources` are edited on the «Mittel», «Mittel-Bestände»
    // and «Quellen» sheets of the Arbeitsmappe (§9h) – there is no form for them. `units` is NOT
    // in the workbook and is carried over untouched by it: a config file is the only way to set it.
    // `catalogue[].when` (the symbol-variant rule – `{"Typ": "Exhauster"}`, a list of clauses
    // being an OR) is likewise preserved by the workbook on an id match, never written by it.
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
    "staleIncidentDays": 30,                      // …and incidents that WERE worked on but never closed,
                                                  // N days after the last edit. Never stamps report_done_at
                                                  // (the Rapport was not finished) and stays reversible via
                                                  // Reaktivieren; the Verlauf records why. 0 = off
    "captureWindowHours": 12,                     // how long the Erfassungs-Poster link (below) reaches
                                                  // an incident after it opened
    "webhooks": [],                               // outbound: POST on every incident creation (payload +
                                                  // adapters: docs/ALARM-INTEGRATIONS.md); fail-open
    "groups": []                                  // station alarm groups for the Alarmierungs-/Ausrück-
                                                  // zeiten grid (rapport form, Erfassungsblatt, milestone
                                                  // webhook, stats export). Empty = grid hidden. Example:
                                                  // { "id": "g2", "label": "Gr. 2", "color": "Rot" }
                                                  // ⚠️ `color` is NOT a colour – see below
  },

  "alarmKeywords": null,                         // the station's OWN alarm vocabulary – see §1a.
                                                 // admin sessions only; withheld from anonymous GET.
                                                  // null / omitted (normal) = the vocabulary shipped
                                                  // in backend/app/data/alarm_keywords.json

  "report": {                                    // Einsatzrapport form presets
    "partnerOrgs": [],                            // Partnerorganisationen checkbox row (paper + form);
                                                  // empty = no preset row, free text stays possible
    "reversePrintOrder": true,                    // station printer ejects face-up → reverse the
                                                  // relayed document; the download stays in order
    "hoursRounding": {                            // the BRACKETED Einsatzstunden figure – see §1b
      "stepMin": 30,
      "graceMin": 5
    },
    "attendanceMergeGapMin": 15,                  // presence blocks less than this far apart print
                                                  // as ONE stretch on the Personalblatt – see §1c;
                                                  // 0 = print every recorded block as recorded
    "links": []                                   // the station's own forms, as a tick-off list on
                                                  // the Rapport – see §1d. Empty = no such section
  },

  "integrations": {                              // ⚠️ ACCEPTED AND IGNORED. Availability is
    "diveraEnabled": false,                       // derived from the env credentials (§6), never
    "traccarEnabled": false                       // from this block; `GET /api/config` answers
  }                                               // with `diveraConfigured`/`traccarConfigured`
                                                  // instead. Setting these turns nothing on.
}
```

> **Validation:** the CLI/backend reject malformed config and CRS ambiguity (both `center` and
> `centerLv95` set). Asset-reference validation is tied to the asset-upload path; until then,
> config review should verify referenced files exist in the deployment store.

### ⚠️ `alarms.groups[].color` is not a colour

It is the **parenthetical printed after the group's Bezeichnung** on the two paper documents:
`"label": "Gr. 2"` plus `"color": "Rot"` prints **«Gr. 2 (Rot)»** on the Einsatzrapport's
Alarmierungs-/Ausrückzeiten grid (`src/lib/report.ts`) and on the paper Erfassungsblatt
(`src/admin/capturePdf.ts`). Free text – nothing parses it, nothing renders it as a colour, and
no CSS or map surface reads it. The name is a historical accident. The form on **Alarme &
Einsätze** calls it «Zusatz in Klammern (optional)» and previews the printed line, which is what
the field actually is; a station using its groups' colours as names («Rot», «Grün») is why it
looks like one.

`alarms.groups[].winfapAlias` and `alarms.groups[].tagespikett` are **read by nothing in this
repository.** They still validate, they still round-trip, and the admin form deliberately gives
them no input while merging them through untouched – but do not build on them: they are dropped
at the next MAJOR, together with the `autoOpen*` keys above.

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

## 1b. `report.hoursRounding` – Einsatzstunden on the printed rapport

The rapport carries one summary line under the roster:

```
6 Anwesende · Einsatzstunden 14:35 · gerundet 16:00
```

**The first figure is raw** – every person's presence blocks summed to the minute, never rounded.
That is what actually happened, and it is what the second figure has to be checkable against.

**The second is the Sold convention.** Each person's own time is rounded UP to the next `stepMin`
block, but only once `graceMin` past the previous one; the rounded values are then summed. With
the shipped default (`stepMin: 30`, `graceMin: 5`):

| served | counts as |
| --- | --- |
| 0:00 – 0:05 | 0:00 |
| 0:06 – 0:35 | 0:30 |
| 0:36 – 1:05 | 1:00 |
| 1:06 – 1:35 | 1:30 |

The grace is what stops a crew that stayed three minutes over the half hour from being counted a
whole block for it.

**Rounding is per person, then summed – never on the total.** Three people at 0:20 each are 1:00
raw and 1:30 rounded; rounding the total instead would say 1:00 and quietly make the answer depend
on how many people happened to come.

A station that counts whole hours sets `{"stepMin": 60, "graceMin": 10}`. Set it in the admin UI
under **Rapport → Rundung**, which shows a worked example under the two fields; the value is the
same on every rapport that station prints.

**The rule itself is NOT printed on the sheet.** It is identical on every rapport a station ever
produces, so printing it would repeat the same sentence on every sheet forever – it belongs in the
Weisung, next to the other conventions the people signing these sheets already work to. The
figure it produces is checkable against the raw number beside it, which is why the raw one is
printed at all.

⚠️ This is a summary for the person signing the sheet, not accounting. Sold and kantonale
Statistik are computed in WinFAP from the recorded von–bis, and the per-person Stunden columns
stay off the paper deliberately (field-classification decision, 2026-07-17).

---

## 1c. `report.attendanceMergeGapMin` – two ticks that are one arrival

Presence is recorded in blocks: somebody arrives, leaves, comes back. Two blocks a minute apart
are almost never two deployments – they are a corrected mis-tap, or the QR poster and the tablet
recording the same arrival from two sides. Printed as recorded that came out as two lines under
one name:

```
Keller Laura        08.08. 22:11 – 08.08. 22:58
                    08.08. 22:59 – 08.08. 23:20
```

…which reads as a person who went home during an Einsatz that never stopped. With the shipped
default of 15 minutes the sheet prints one stretch, `22:11 – 23:20`.

**The record keeps both blocks.** Only the rapport merges them, and the Anwesenheit surface still
shows and edits exactly what was recorded – that is where a wrong tick is corrected. The
Einsatzstunden follow the same merge, so the hours under the roster add up to the lines above them.

**A station number, not a per-incident one.** Whether a ten-minute gap is «a break» or «two
deployments» is a Weisung, and it has to mean the same on every sheet the Wehr files – so it is
not something an EL settles at 3am. A Wehr that runs long deployments with real Ablösungen and
wants every one of them on paper sets `0`.

---

## 1d. `report.links` – the station's own forms, on the Rapport

Every Wehr has paperwork that lives outside this app and still has to be filled in after an
Einsatz: a Getränke-Abrechnung for the Gemeinde, a Schadenmeldung for the Versicherung, an
internal form. `report.links` puts them on the Rapport as a tick-off list under the Beilagen –
title, an optional note saying *when* it has to be filled in, and a link that opens it.

**The shipped default is an empty list, and that is the intended state for most deployments** –
these forms are one station's own, so no default here could ever be right for another. Configure
none and the section does not exist: no empty card, no chip, nothing explaining a feature this
station does not use. Edit the list in **Verwaltung › Rapport**; a row whose URL is not
`http`/`https` is dropped rather than rendered as a link the app will not open.

An illustrative entry (the ids below are made up – yours come from your own form):

```json
"links": [
  {
    "id": "getraenke",
    "title": "Getränkeabrechnung Gemeinde",
    "note": "Nur wenn Getränke bezogen wurden",
    "url": "https://forms.example.ch/getraenke?usp=pp_url&entry.111111111={einsatzleiter}&entry.222222222=Einsatz {datum}"
  }
]
```

### Placeholders

The URL may carry `{platzhalter}` tokens, substituted **URL-encoded** at the moment the link is
opened – so the form comes up with the incident already in it instead of blank:

| Token | Value |
|---|---|
| `{stichwort}` | the alarm title |
| `{ort}` | the address |
| `{datum}` | date of the Alarmierung (`14.08.2026`) |
| `{alarmzeit}` | Alarmierung, date **and** time |
| `{einsatzende}` | Einsatzende, date and time |
| `{einsatzleiter}` · `{kontaktperson}` | the two names off the Rapport |
| `{kurzbericht}` | the Kurzbericht text |
| `{wehr}` | the station's own name (`identity.appName`, falling back to `KP Front`) |

An **empty** field resolves to an empty string (a rapport is written while the Einsatz runs). An
**unknown** token is left standing verbatim: a typo then shows up as `{einsatzort}` in the preview
in Verwaltung and in the opened form, which is the only way anybody would ever find it. Only the
substituted values are encoded – the separators typed between them stay literal, because the same
string carries the `&` and `=` that hold the query together.

**Google Forms**: press *«Link zum Vorausfüllen abrufen»* in the form, type sample values, copy
the link, then swap the sample values for placeholders. The resulting URL has the shape
`?usp=pp_url&entry.<feld-id>=<wert>`. Anything else that prefills from the query string works the
same way.

### ⚠️ A placeholder sends incident data to whoever hosts the form

This is the part to think about before configuring one. `{ort}` is the incident address,
`{einsatzleiter}` and `{kontaktperson}` are named individuals, and `{kurzbericht}` is free text
that in this line of work routinely describes what was found at an address – including health
details about the people who live there. Put one in a link and that data travels **in the URL**
to whoever runs the form. `noreferrer` does not help here: the data *is* the address being
opened. It lands in the form provider's logs, in the operator's browser history, and is visible
to any browser extension on that device.

Use the narrow tokens (`{datum}`, `{stichwort}`, `{wehr}`) for third-party forms, and keep
`{kurzbericht}`, `{ort}` and the two names for forms your own Gemeinde or Kanton hosts. A
Google Form means Google. See [`PRIVACY.md`](../PRIVACY.md).

**The links are withheld from anonymous callers.** `GET /api/config` is unauthenticated by
design (the login screen needs the station's branding before anyone logs in), but `report.links`
is served only to a **signed-in** session – a PIN user or an admin. A prefill URL is a
capability: whoever holds it can submit to that form. An anonymous caller sees `links: []`,
byte-identical to a station that has configured none, so the withholding does not announce
itself either.

The app reads the config at boot, *before* login, so the very first fetch on a fresh device
comes back without them; the login re-reads it (`lib/auth` · `login`), and every later boot
already carries the session cookie.

That means "everyone with the station PIN", not "everyone". It is not a secret store: anyone who
can open the Rapport can read the URL, and it is in their browser history the moment they use
it. Do not put a token, a key or a secret path in a link, and prefer a form that is itself
restricted (Google Forms can require a sign-in from your own organisation) over one that is
open to whoever has the address.

### What it deliberately is not

- **Not printed.** The rapport is the record; a to-do list of links is not part of it.
- **Not an Abschluss-Assistent step.** A station's own paperwork does not belong in this app's
  completion model, and it must never be able to hold up an archive.
- **Not in the Verlauf.** Ticking off the Getränkeabrechnung says nothing about the Einsatz, and
  the Verlauf is the record of the Einsatz (`lib/report · META_QUIET`).
- **Never ticked automatically.** Opening a form says nothing about whether it was submitted. The
  app offers the tick once, when the operator **comes back** from the form – offered at the press
  it would expire on a tab that had just lost focus. The tick is per-incident, lives in the
  workspace blob, and merges per link id, so two devices ticking two different forms keep both.

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
  send CORS headers** (the browser fetches it directly).
- Station gets the URL + layer name from its canton/commune GIS GetCapabilities.
- **Add one in the browser** at `/admin` → **Kartenebenen**: label, id, group, WMS/WMTS, the tile
  URL templates (one per line) and the attribution. The form **merges** over the stored row rather
  than rebuilding it, so `nightColor`, `opacity`, `maxzoom`, `symbol` and `autoActivate` – which
  have no input – survive an edit made next to them. Setting *those* still needs a config file or
  a manifest, and a whole library still wants `admin_geodata` (§9d).

### 2b. Vector layer (GeoJSON) – *for points/lines you own*
```jsonc
{
  "id": "hydrant",
  "group": "Wasser",
  "label": "Hydranten",
  "icon": "drop",
  "kind": "geojson",
  "geojson": "/api/reference/geo:hydrant",  // same-origin reference-store URL; a browser
                                        //   upload appends `?v=<version>` (see below)
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
You never write the `geojson` URL by hand. Two doors put the file in the reference store and
write this render config (with the resolved `/api/reference/geo:<slug>` URL) into
`referenceLayers`:

- **`/admin` → Kartenebenen**, for one layer at a time – upload the `.geojson`, fill in the
  label/group/colour, and it is live. **Replacing** the file later bumps the dataset **version in
  place**: the same layer id, a new `/api/reference/geo:<slug>?v=<n>` URL, so every device's
  service-worker cache misses and re-fetches instead of serving last year's hydrants. It does not
  mint a sibling layer. WGS84 is enforced in the browser, with a reprojection hint on rejection.
- **The `admin_geodata` CLI** (§9d), from a *manifest* – a layer entry plus a `file:` pointing at
  the GeoJSON. This is the path for a whole library at once, and for the fields the form has no
  input for (`nightColor`, `opacity`, `maxzoom`, `symbol`, `autoActivate`).

Restricted data (e.g. utility cadastre) stays in a **private data repo**, never in this one.

---

## 3. Uploaded assets & their formats

Stored in the asset store – a directory on the deployment's volume, `MEDIA_STORAGE_DIR`. There
is no object-storage backend for assets; back the volume up (`DEPLOYMENT.md` §6). Upload size
follows `MAX_UPLOAD_MB` (§6; default 110).

### 3a. Branding

| Slot | Asset | Format | Notes |
|------|-------|--------|-------|
| `logo` | Logo | SVG (preferred) or PNG | shown in login/header; transparent background |
| `reportLogo` | Report logo | SVG (preferred) or PNG | letterhead above the title on the printed Einsatzrapport – **empty falls back to the Logo**. Its own slot because a mark carrying the station's full name reads badly in a header and right on paper. |
| `favicon` | Favicon | SVG or ICO | browser tab |
| `iconPng192` | App icon 192 | **square PNG**, 192×192 | home-screen icon of the installed app |
| `iconPng512` | App icon 512 | **square PNG**, 512×512 | home-screen icon and splash screen |

`POST`/`DELETE /api/branding/{slot}` and `admin_branding` (§9c) accept those five slots, nothing
else. The two app icons are validated on their **bytes**, not their Content-Type: a non-PNG is
refused with 415, a non-square or wrongly-sized image with 422 naming the size you actually
uploaded. A larger square export is accepted and scaled down (nominal edge up to 4×), so a 1024²
icon is fine for either slot.

This validation does not make arbitrary SVG a safe untrusted document. Branding SVG is served
with a route-specific sandbox CSP, but a deployment-admin-supplied `symbols:*` catalogue is
rendered as inline tactical markup. In the supported one-station/custom model, the deployment
admin and private station-data repo are therefore a trusted code-equivalent boundary. Managed
hosting or delegated/untrusted upload access requires SVG sanitization plus an application-wide
CSP first; see [`SECURITY.md`](../SECURITY.md#accepted-single-station-deployment-constraints).

`/manifest.webmanifest` is **served by the backend**, not shipped as a static file: it takes the
built manifest and overlays `identity.appName`, `identity.locale`, `accentColor` (as `theme_color`)
and whichever of the two icons exist. A deployment that has uploaded neither keeps the bundled
KP Front icons, and any garbage in the config degrades to the built manifest rather than erroring –
this file is fetched by every tablet on every load.

⚠️ **iOS captures the home-screen icon when the app is added and never re-reads it.** A tablet that
already has KP Front on its home screen keeps the old icon until it is removed and re-added. This
is the usual "the rebrand didn't work" report, and it is not fixable from the server.

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

`roster.nameOrder` selects how they are **spelled**, station-wide: `"last-first"` (default,
«Meier Hans» – what Divera delivers and how crew lists and Soldblätter sort) or `"first-last"`
(«Hans Meier»). It is applied when a name is served, not when it is stored, so flipping it takes
effect on every device at once and needs no re-sync – but a name already frozen into a printed
Rapport or a closed incident keeps the spelling it was captured with. Set it in the admin UI
under **Personal**; everything downstream (lists, map tags, the Rapport, the print) follows,
including the abbreviated Trupp tag («Meier H.»), which uses the order to tell surname from
given name.

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
  | `rank` | – | Dienstgrad, matched case/accent-insensitively against `roster.ranks` `key`/`label`/`abbr`; a value the list does not know **stops the import before anything is written** – see below |
  | `provider` | – | provider key an external identity is filed under (`personnel_external_identities.provider`) |
  | `external_id` | – | that provider's id for this person; required whenever `provider` is given |
  | `divera_id` | – | legacy spelling of `provider=divera` + `external_id`, accepted during the compatibility window – prefer the two columns above |
- Encoding UTF-8, comma-separated, header row required. Extra columns ignored. A row carrying a
  `provider`/`external_id` pair already known **updates** that person; everything else is added.
- The admin UI's «Beispiel-CSV herunterladen» button writes the minimal form (`name,rank`).

**Unknown Dienstgrade are decided before the import runs.** `POST /api/personnel/import-csv/preview`
reads the file and writes nothing; it answers with every rank value the station's list does not
cover, **grouped by value** (three people spelled `Sdt` are one entry, not three warnings) plus
the people behind it and a spelling proposal. The Verwaltung shows that as «Grade zuordnen», and
each value gets one of three answers, sent back to `POST /api/personnel/import-csv` in the
`decisions` form field:

| action | meaning |
|--------|---------|
| `map` | put the value on an existing rank (`rank` = its key) – for this file only |
| `adopt` | take it into the station's `roster.ranks` as a new rank, appended at the end (junior-most). **Writes config**, so it needs an admin session |
| `skip` | import those people without a Dienstgrad – reported back in the result |

A value with no decision is refused with `409` and **nothing** is written – not the ranks, not the
people. That is the point: the previous contract imported everybody, dropped the ranks it did not
recognise and listed them afterwards under a green success badge.

⚠️ `adopt` on a station whose `roster.ranks` is empty writes the shipped Swiss default list **plus**
the new ranks. The default was already the effective list (every reader falls back to it), so
storing only the adopted ones would strand every person already carrying `wm` or `kpl`.

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
- **Changing a PIN is admin-only – there is no self-service PIN change.**
  `POST /api/auth/users/{id}/pin` is the only way a PIN is set after account creation, and it is
  gated on the admin session (`backend/app/auth/router.py`), so a person who wants a new PIN asks
  whoever holds the `ADMIN_SECRET`. The «PIN ändern» action exists only in `/admin` → Personen –
  a logged-in user has no screen to change their own PIN, and there is no recovery flow to go
  looking for.

---

## 6. Environment variables (secrets / infra – operator, not admin)

Set at deploy time, never in the repo. **Seventeen of them are also settable from the browser** –
see the rule immediately below; everything else in the table really is deploy-time only.

### The seventeen integration credentials – env **or** `/admin` → Zugangsdaten

The station's integration settings – the three Divera keys, the Traccar trio, the VAPID trio, the
four STT settings, the CARTO browser key, `ALARM_WEBHOOK_SECRET`, `PRINT_AGENT_SECRET` and `HEALTHCHECK_PING_URL` – no
longer have to come from `.env`. An admin can set and rotate them at `/admin` → **Zugangsdaten**,
where they are stored **encrypted** in the `integration_credentials` table (AES-256-GCM, key
derived from `SECRET_KEY` via HKDF-SHA256, the credential's own name as AAD) and take effect
**without a restart** – the resolver re-reads the stored half every 30 s and immediately on a
write. They are marked 🔐 in the table below.

Four rules, and none of them is optional reading:

1. **A value in `.env` wins and locks the field.** The browser shows it as server-set, names the
   variable, and offers no input; the API answers **409** to a `PUT` or `DELETE`. **Existing
   deployments therefore change behaviour not at all.** "Supplied" means *different from the
   application's own default* – `docker-compose.yml` names all seventeen variables and materialises
   the default for `STT_MODEL`, `STT_LANGUAGE` and `VAPID_SUBJECT`, and a compose passthrough is
   not a deployer's decision.
2. **Secrets are write-only.** They can be set and rotated over the API, never read back. Seven
   fields are readable because each earns it individually: `TRACCAR_URL` (a hostname the System
   card already prints), `VAPID_PUBLIC_KEY` (already handed to every logged-in browser),
   `VAPID_SUBJECT`, `STT_BASE_URL`, `STT_MODEL`, `STT_LANGUAGE`, and `CARTO_API_KEY`. The CARTO
   key is the deliberate exception: CARTO requires it in every browser tile URL, so domain
   restrictions in CARTO – not secrecy – prevent use elsewhere. **Readable is not public**,
   though: `/api/config` serves it only to a caller that already holds a session (PIN user,
   admin, or an incident link) and withholds it from anonymous ones – see the row in the table
   below. `TRACCAR_EMAIL` is *not* readable –
   it is half of a credential pair – and neither is `HEALTHCHECK_PING_URL`, whose one misuse is
   pinging it so the monitor believes a dead station is alive.
3. **Rotating `SECRET_KEY` now costs more than the PINs.** It is the key the credentials are
   sealed with, so a rotation makes **every stored credential undecryptable** on top of breaking
   every PIN. They then report as «unlesbar» – never as «nicht konfiguriert» – and that
   integration is off until somebody sets it again. Same never-rotate rule as always, one more
   consequence: [`DEPLOYMENT.md`](DEPLOYMENT.md) §SECRET_KEY.
4. **Who set what is recorded.** `GET /api/integrations/credentials-audit` and the «Letzte
   Änderungen» list on the page carry name, action (`set` / `rotated` / `cleared`), when and by
   whom – **never a value**, not even encrypted. A row with no name means nobody was signed in
   behind the write (the installer, a script).

**What deliberately stays env-only, and why:**

| Stays in `.env` | Because |
|---|---|
| `SECRET_KEY` | it peppers the PINs in the database it would live in, and seals the credential table itself |
| `ADMIN_SECRET` | it gates writing the very document it would live in |
| `KP_TELEMETRY_ENABLED`, `KP_TELEMETRY_DSN` | the deployer's veto **over** the admin UI – an admin-settable veto is not a veto |
| `REQUIRE_PLAN_DIGEST` | it guards the config a stale automated publish would overwrite |
| `DATABASE_URL`, `POSTGRES_*`, `APP_PORT`, `APP_BIND`, `DOMAIN`, `COOKIE_SECURE`, `KP_FRONT_TAG` | host-level: read before a database connection exists, or by `docker-compose.yml` rather than by the app |
| everything else in the table below | not an integration credential – seeding, caps, tuning, provider URLs, the S3 pull keys |

The `PLANS_S3_*` pair is the one genuinely secret-shaped thing that is **not** in the store: the
plan pull is scheduled at boot from the environment (§6a), not per tick.

🔐 = also settable at `/admin` → **Zugangsdaten** (encrypted in the database; a value here wins
and locks the field – see the rule above).

| Env var | Purpose |
|---------|---------|
| `DATABASE_URL` | Postgres connection (`postgresql://…`; auto-upgraded to asyncpg) |
| `SECRET_KEY` | JWT signing + PIN pepper (≥32 chars; **required in prod**) |
| `ADMIN_SECRET` | unlocks the `/admin` UI + admin-write API/CLI, separate from the editor PIN (≥16 chars; empty = admin disabled, fail-closed) |
| `MEDIA_STORAGE_DIR` | local asset/media dir (default `data/storage`). **There is no S3 media backend** – the asset store is a directory on a volume, full stop (`app/storage.py`). The only S3 the app speaks is the optional Objektplan-Pull below. |
| `PUBLIC_URL` | this deployment's public origin (e.g. `https://front.example.org`), used to compose absolute links in outbound webhooks (the capture URL on an alarm slip). Empty = those links are omitted |
| `APP_BIND` | *(read by `docker-compose.yml`, not by the app)* which host address the app's port is published on: `0.0.0.0` (default) for a trusted LAN, `127.0.0.1` as soon as anything terminates TLS in front. ⚠️ A published port is open whatever `ufw` says. The four shapes and why: [`DEPLOYMENT.md` §3](DEPLOYMENT.md#app_port-and-app_bind) |
| 🔐 `DIVERA_ACCESS_KEY`, `DIVERA_WEBHOOK_SECRET` | if `diveraEnabled` |
| 🔐 `DIVERA_PERSONNEL_ACCESS_KEY` | optional second Divera key used **only** for the «Personal» pull. It must belong to a user whose read scope includes members' Qualifikationen – the alarm key above usually does not – and it is what makes the roster sync derive a Dienstgrad. Empty = falls back to `DIVERA_ACCESS_KEY` (names only, no rank) |
| 🔐 `ALARM_WEBHOOK_SECRET` | generic alarm intake `POST /api/alarms` for non-Divera alerting systems – auto-opens an incident per alarm, idempotent on `source`+`source_id` (nothing set anywhere = endpoint disabled, fail-closed). `./scripts/setup.sh` mints this one and `DIVERA_WEBHOOK_SECRET` into the credential store on a fresh install, so a station reads and rotates them at `/admin` → Zugangsdaten – [`ALARM-INTEGRATIONS.md`](ALARM-INTEGRATIONS.md) §1 |
| 🔐 `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push for killed-app alarms + new-alarm push. Generate the pair once – on a Docker-only host `docker compose exec app uv run python -m app.gen_vapid`, or `cd backend && uv run python -m app.gen_vapid` where the toolchain is installed – then paste both halves into `/admin` → Zugangsdaten, which takes effect without a restart. `./scripts/setup.sh` does exactly that on a fresh install, into the credential store rather than into `.env`. Nothing set anywhere = push disabled, fail-closed. ⚠️ Generate **once** and keep the pair stable: rotating it invalidates every stored subscription |
| 🔐 `PRINT_AGENT_SECRET` | station print relay: «An Stationsdrucker» queues the Einsatzrapport-PDF for an on-site agent (any always-on box with a CUPS queue). The agent serves KP Front *and* KP Rück from one install – see [`tools/PRINT-AGENT.md`](../tools/PRINT-AGENT.md). Nothing set anywhere = agent endpoints 403 and the button never renders, fail-closed. ⚠️ **Deliberately not minted by the installer**, unlike the two webhook secrets: this secret *is* the switch, so setting it renders «An Stationsdrucker» on the Rapport and on the capture poster for a station that owns no printer, and turns the System card's print-relay row from «nicht konfiguriert» into a permanently offline connector. (The old reason – that it would schedule a background job – is wrong: the sweep is registered unconditionally and returns on its first line when no secret is set.) Generate it on the agent's own machine with `openssl rand -hex 32` and paste the same value into `/admin` → Zugangsdaten |
| 🔐 `HEALTHCHECK_PING_URL` | dead-man's switch: **the job GETs this URL every 60 s** (healthchecks.io or any cron monitor), so the monitor alerts when the pings *stop*. Catches the class an HTTP probe of `/ready` cannot: a container stopped with nothing replacing it, or a wedged event loop. Point it at a check with a **1 min period and ~3 min grace** – matching the 60 s cadence, so two missed pings raise it. Nothing set anywhere = the heartbeat job still runs but returns on its first line, so nothing is pinged; a failed ping is logged and swallowed, so a monitoring outage never disturbs the deployment. The «Einrichtung» card on the admin landing page links straight to this field |
| 🔐 `TRACCAR_URL`, `TRACCAR_EMAIL`, `TRACCAR_PASSWORD` | if `traccarEnabled` |
| 🔐 `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`, `STT_LANGUAGE` | speech-to-text for the audio player's Transkribieren (OpenAI-compatible `/v1/audio/transcriptions`; base URL without `/v1` – Groq: `https://api.groq.com/openai`, OpenAI: `https://api.openai.com`, or a self-hosted faster-whisper server). Empty base URL = off, fail-closed. **Audio is sent to that server** – prefer self-hosted for sensitive deployments |
| 🔐 `CARTO_API_KEY` | browser key for the built-in CARTO Voyager and Dark Matter raster basemaps. Request it for the deployment domains at [CARTO Basemaps](https://carto.com/basemaps/apikey/). The runtime config appends it as `?key=` to every CARTO tile template the BROWSER fetches – map pickers, the admin object map, offline downloads. **⚠️ Restrict it to the deployment domains in CARTO**: it is necessarily visible in browser requests, and that restriction rather than secrecy is what stops it being spent elsewhere. Never commit a real value. Two things narrow it further: `/api/config` hands it only to callers that already hold a session (PIN user, admin, or an incident link – the login screen draws no map and does not get it), and **Rapport/Kroki tiles are fetched server-side with this same credential**, so the browser's copy never travels in a request body, a log line or a tile-cache filename. Empty = the provider's unkeyed/watermarked response is shown. |
| `PLANS_S3_ENDPOINT`, `PLANS_S3_BUCKET`, `PLANS_S3_PREFIX`, `PLANS_S3_REGION`, `PLANS_S3_ACCESS_KEY_ID`, `PLANS_S3_SECRET_ACCESS_KEY`, `PLANS_PULL_INTERVAL_MINUTES` | Objektplan-Pull – see [§6a](#6a-objektplan-pull-fetch-modul-pdfs-instead-of-having-them-pushed-in) (empty endpoint/bucket/key/secret = no pull, fail-closed). **These are the only `S3_`-shaped variables the app reads**, and they are prefixed `PLANS_S3_` – there is no bare `S3_ACCESS_KEY_ID` |
| `MAX_UPLOAD_MB` | request-body cap for multipart uploads (default 110 – must stay above the media endpoint's 100 MB per-file cap) |
| `REQUIRE_PLAN_DIGEST` | make `PUT /api/objects/{id}/plans/{module}` **refuse an automated publish** (admin secret, no logged-in user – i.e. `admin_objects push`) that does not declare the SHA-256 of the bytes it carries. A declared digest is verified everywhere, always; this only decides whether one is *mandatory*, and only for machines – a person uploading a PDF in the admin UI is never affected. Unset = auto: on for the public demo (`DEMO_RESET_CRON`/`DEMO_RESET_SECONDS`), off for a station, so an older `admin_objects` keeps working. ⚠️ It is a **wrong-tree** guard, and deliberately server-side: the `sha256` pin in `objects.manifest.json` cannot catch a stale checkout, because such a checkout brings a stale manifest *and* a stale CLI. Turning it on means a publisher too old to name its own bytes is refused – which is precisely the publisher you do not want |
| `GEOCODER_URL` | address-autocomplete endpoint (default the swisstopo SearchServer – see the caveat below) |
| `EXPOSE_API_DOCS` | serve `/docs`, `/redoc` and `/openapi.json` on a **production** deployment (always on in dev). Default off |
| `SEED_DATABASE`, `DEV_CREATE_ALL` | dev seeding / auto-create tables (prod uses Alembic) |
| `SEED_PIN` | **Required in production** when `SEED_DATABASE` is on: the six-digit PIN the seeded account gets. The seed file's own PIN is public, so the backend refuses to boot without this rather than create a login anyone knows |

Weather (MeteoSwiss/Open-Meteo) and the swisstopo geocoder need **no** credentials – public
endpoints, national, work everywhere *in Switzerland*. One honest limitation: the geocoder
client speaks the swisstopo SearchServer API shape only, so outside Switzerland address
autocomplete simply returns nothing (map-pick still works). `GEOCODER_URL` exists to point at
a *compatible* endpoint (e.g. a proxy) – it is **not** a generic-geocoder swap point for
Nominatim/Google/etc.

### 6a. Objektplan-Pull (fetch Modul-PDFs instead of having them pushed in)

A station whose plan library is maintained elsewhere can publish it to an **S3-compatible
bucket** and let the deployment fetch from there on a schedule, instead of giving that system an
`ADMIN_SECRET` – a credential for the entire admin API – so it can push. The bucket holds
`plans/index.json` (object id, module, filename, size, **sha256**, address – metadata, never
bytes) and `plans/<object-id>/<module>.pdf`; only a checksum that actually changed is
downloaded, and it lands as the same `plan:<obj>:<module>` dataset a manual upload writes.

Any S3-compatible store works – MinIO, Backblaze B2, a hosted bucket, AWS – and a **read-only**
key is enough; nothing about a provider is built into the app. `PLANS_S3_PREFIX` is optional,
`PLANS_S3_REGION` is whatever your provider's docs say verbatim. Existing plans are **never
deleted** by a pull, and a malformed or incomplete index refuses the whole run rather than
ingesting half of it. Fail-closed: no endpoint/bucket/key/secret → no job is scheduled, nothing
is fetched, and plans stay exactly as they were loaded. Index format and the reasoning:
[`objektplaene-architecture.md`](objektplaene-architecture.md).

### 6b. Three things that look like env vars and are not

Each of these is a **token or key stored in the database** and managed in the admin UI, not set
at deploy time. They are listed here because that is where people go looking for them. (Unlike
the seventeen 🔐 credentials above, these three have **no** environment variable at all – there is
nothing to put in `.env` and nothing that could outrank the stored value.)

| Feature | Where it is managed | What it does |
|---------|---------------------|--------------|
| **Erfassungs-Poster** (station capture) | `/admin` → Personen › Erfassung: activate / rotate / disable, print the A4 poster | Scanning it opens `/e/<token>`, where attendance, Material and notes for incidents of the last `alarms.captureWindowHours` are recorded **without a login**. Fail-closed: no token → the whole `/api/capture/*` surface answers 403. Rotation invalidates every printed poster at once. |
| **Statistik-Export** | `/admin` → Daten › Statistik-Export | `GET /api/stats/incidents?year=` returns one flat read-only JSON record per incident (metadata, Zeiten, Anwesenheit von–bis, Mittel totals, Rapport status) for external analytics – auth via the `X-Stats-Token` header or `?t=`. Fail-closed: no token → 403. Full field reference: [`STATS-EXPORT.md`](STATS-EXPORT.md). |
| **Einsatz-Link** (read-only link into one incident) | `/admin` → Daten › Einsatz-Link: show, rotate or delete the station's `incident_link_key` | Copy the key into the alerting system, which signs a token with it and puts `/l/<token>` into the alert it sends out. A responder taps that on a personal phone and sees **one** incident the way a `viewer` does – no login, nothing that writes, prints or costs money – for as long as the Einsatz runs: closing or archiving it revokes every open link at once (12 h is the backstop for the one nobody closes). Fail-closed: no key → the link surface answers 403 and nothing exists, which is also what an existing deployment gets from the migration. Rotation or deletion invalidates every link already sent out and requires reconfiguring the alerting system. Trust model and reachable surface: [`ALARM-INTEGRATIONS.md`](ALARM-INTEGRATIONS.md) §4. |

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

---

## 8. Empty state (a brand-new deployment)

A deployment with an empty config must be fully operable:
- swisstopo base map, centered on a neutral default until `map.defaultView` is set;
- no reference layers, no hydrants, no plans, no roster – and **nothing errors**;
- every person/unit picker offers **free-type entry** (no "select from empty list" dead-ends);
- optional layers/integrations that aren't configured are shown as "nicht konfiguriert", never
  as empty-but-implied-complete.

---

## 9. Loading station data with the admin CLIs

Everything a station provides – the config document, its brandmark, reference layers, object
plans, checklists – is loaded by one of five sibling CLIs in `backend/app/`.

**None of them is the only door any more.** Every one of those five now has a browser
equivalent for working on **one thing at a time**: the config on the Station pages, the
brandmark on Station & Karte, a map layer on **Kartenebenen**, an Einsatzobjekt and its
Modul-PDFs on **Objektpläne**, a checklist template and its diagram pages on **Checklisten** –
plus the Arbeitsmappe (§9h) for the list-shaped data. That is where a station normally
administers itself, and none of it needs a terminal.

**What the CLIs are still for** is the other half of the job: a whole library in one run, a
manifest that is reviewed and versioned in a private data repo, a station reproduced on a second
deployment, and the handful of fields no form exposes. Station files are private and **never
committed** (`backend/private/` is gitignored).

> **On a host that has nothing but Docker** – which is the whole list [`SETUP.md`](SETUP.md) asks
> for – prefix any of these with `docker compose exec app`, run from the installation directory:
>
> ```bash
> docker compose exec app uv run python -m app.admin_config show
> docker compose exec app uv run python -m app.admin_objects schema
> docker compose exec app uv run python -m app.gen_vapid
> ```
>
> The image carries `uv` and the application, and the working directory inside it is already
> `backend/`, so nothing has to be installed. **The honest limit: reading and generating work in
> the container; `load` and `push` of a file *you* wrote do not.** The container holds the
> repository's `*.example.json` templates and nothing else – your manifest, your GeoJSON and your
> Modul-PDFs are on your workstation, and a `load` cannot open a file it cannot see. For those,
> `uv` on a machine that has the files is still the answer.

### 9a. What all of them share

**The loop is the same:** `schema` → author the file → `validate` → (`diff`, config only) →
`load` **or** `push`. Invalid input prints precise `field.path: message` lines and exits
non-zero, having written nothing. The one exception is `admin_branding`, whose input is an image
rather than a document: it has only `load`, `push` and `show`. Verb matrix:
[`API.md`](API.md#configuration--data-cli).

**`load` vs `push` – pick by where you are standing:**

| | `load` | `push` |
|---|---|---|
| talks to | the database in `DATABASE_URL`, and the **local** `MEDIA_STORAGE_DIR` | a **running** deployment's HTTP API |
| authenticates with | nothing (it is the database) | `KP_BASE_URL` + `KP_ADMIN_SECRET` (the deployment's `ADMIN_SECRET`) |
| run it | server-side, or against a local dev DB | from a workstation, against a remote deployment |
| files land | wherever the CLI is running | on the **server's own volume** – which is the point |

A `load` run from a workstation against a remote database writes the blobs to your laptop and
the rows to the server, leaving rows pointing at files nobody can serve. That is what `push`
exists to prevent. `admin_config` is the exception with no files of its own, so it can also be
loaded remotely by injecting the database URL (§9b).

**The order matters, in one place:** branding is loaded **after** the config, never before –
`admin_config load` replaces the whole document and `identity.assets` is part of it, so a
brandmark uploaded first is wiped by the config that follows (§1). Everything else is
independent.

**A worked example that gets all of this right** is
[`examples/demo-data/load.sh`](../examples/demo-data/load.sh) – the six steps that turn an empty
instance into the synthetic Musterdorf station, in the order that works, with the branding trap
commented in place. It is the file to copy when writing a station's own `load.sh`:

```text
1  admin_config      load  config.json
2  admin_branding    load  logo / reportLogo        ← after the config, never before
3  admin_geodata     load  geodata.manifest.json
4  admin_objects     load  objects.manifest.json
5  admin_checklists  load  checklists.manifest.json
6  seed_personnel                                    (additive; the crew, so Anwesenheit has people)
```

### 9b. `admin_config` – the deployment config

A station's config is a JSON file (matching §1) loaded with `backend/app/admin_config.py`. This
is the preferred path for technical deployment owners and LLM-assisted edits: reviewable config
file, schema validation, diff, then load.

`schema`/`example`/`validate`/`diff` (against a file) need no DB; `show`/`load`/`history`/
`restore` hit the configured `DATABASE_URL`; `push` needs neither, only a reachable deployment.

```bash
# from backend/ – or prefix with `docker compose exec app` on a Docker-only host (§9)
uv run python -m app.admin_config schema            # the config JSON Schema (the contract)
uv run python -m app.admin_config example           # a populated sample to edit
uv run python -m app.admin_config validate private/<station>.config.json   # parse+validate, no write
uv run python -m app.admin_config diff private/<station>.config.json       # what would change vs stored
uv run python -m app.admin_config load private/<station>.config.json       # validate + upsert (DB-direct)
uv run python -m app.admin_config push private/<station>.config.json       # → running deployment (KP_BASE_URL / KP_ADMIN_SECRET)
uv run python -m app.admin_config show              # print the stored config
uv run python -m app.admin_config history           # the configs this one replaced, newest first
uv run python -m app.admin_config restore <id>      # put one of them back
```

`push --dry-run` authenticates and reports without writing. Both `load` and `push` take
`--force` (see the refusal below).

> ⚠️ **`load`/`push` refuse to empty a section that currently has content** (exit 2), listing
> exactly what would go – `roster.ranks`, `doctrine.alarmBar`, `report.partnerOrgs`. That is what
> publishing an OLD config file looks like, and it is how the public demo lost its Dienstgrade,
> its Atemschutz-Doktrin and its Partnerorganisationen while every step reported success. Check
> the file is the one you meant (`admin_config diff`), and pass `--force` if the emptying is
> genuinely intended – a station dropping its Partnerliste is a real edit.
>
> **Every write keeps the document it replaced** (`deployment_config_history`), whichever path
> made it – the Verwaltung, a CLI push, a branding upload. `history` lists them with when and by
> what, `restore <id>` puts one back, and the restore is itself kept, so stepping back is
> reversible too. This is the safety net that does not depend on having anticipated the write
> path: **a station has no seed file to rebuild from**, so without it a bad `load` is permanent.

Because the config document carries no files, it is the one CLI that can also be loaded
DB-direct against a remote deployment. Against the Railway production DB from a workstation,
inject the public proxy URL (no secrets printed):

```bash
railway run -s Postgres -- bash -lc \
  'cd backend && DATABASE_URL="$DATABASE_PUBLIC_URL" uv run python -m app.admin_config load private/<station>.config.json'
```

`push` is the simpler answer whenever the deployment is reachable over HTTP.

The empty/neutral default row is seeded on first boot (`seed_config.py`); this CLI overwrites
it with the station's values. An empty config is always valid (§8).

### 9c. `admin_branding` – the five branding slots

The brandmark is not part of the config document (§1): the URLs behind `identity.assets` only
exist once a blob has been stored, so the slots are written by the upload path, not by a `PUT`.
`backend/app/admin_branding.py` is that path for a terminal – the admin UI does the same thing
through a browser.

```bash
# from backend/ – or prefix with `docker compose exec app` on a Docker-only host (§9)
uv run python -m app.admin_branding load  reportLogo <station>/report-logo.png   # DB-direct + local blob store
uv run python -m app.admin_branding push  reportLogo <station>/report-logo.svg   # → running deployment
uv run python -m app.admin_branding show                                          # the URLs a deployment serves
```

**Five slots, and only five:** `logo`, `reportLogo`, `favicon`, `iconPng192` and `iconPng512` –
the same allowlist the upload endpoints enforce (`app/api/branding.py`). What each one is for,
and the format and size rules the two icon slots are validated against: §3a.

`load` writes the blob under a key derived from the **slot**, so re-running it overwrites in
place instead of leaving a new orphan behind every time – which is what makes it safe in a
nightly demo reset. Removing a brandmark is `DELETE /api/branding/{slot}` (or the admin UI), not
an empty config field.

⚠️ **Load it after the config, never before** – the ordering trap in §9a.

### 9d. `admin_geodata` – reference layers

Reference layers (§2) are loaded separately from the rest of the config, because they pair
render config with GeoJSON **files**. A station keeps those files + a **manifest** in a private
data repo and loads them with `backend/app/admin_geodata.py` – the GeoJSON goes into the
reference store (served at `/api/reference/geo:<slug>`) and the render config is written into
`deployment_config.referenceLayers`.

```bash
# from backend/ – or prefix with `docker compose exec app` on a Docker-only host (§9)
uv run python -m app.admin_geodata schema             # the manifest-entry JSON Schema
uv run python -m app.admin_geodata example            # a sample manifest to edit
uv run python -m app.admin_geodata validate <dir>/geodata.manifest.json   # + validates every GeoJSON (no DB)
uv run python -m app.admin_geodata load <dir>/geodata.manifest.json       # upload files + write referenceLayers
uv run python -m app.admin_geodata push <dir>/geodata.manifest.json       # → running deployment (KP_BASE_URL / KP_ADMIN_SECRET)
uv run python -m app.admin_geodata show               # print the stored referenceLayers
```

A manifest entry is a `referenceLayers` entry (§2) plus, for a `geojson` layer, a `file:`
(local GeoJSON, relative to the manifest) instead of a pre-resolved URL. GeoJSON is validated
as a **WGS84 `[lng, lat]`** FeatureCollection (LV95 rejected, §3b). Layer `id`s match what the
frontend persists as `layerState`, so saved layer visibility carries across a refresh.

**Storage caveat for remote loads.** A full `load` writes the GeoJSON to the *local*
`MEDIA_STORAGE_DIR`, so run it **server-side** for a fresh deployment – or use `push`, which
goes through the API so the server writes its own volume. There is also
**`load --config-only`** (inject `DATABASE_PUBLIC_URL`, like `admin_config`): it writes just
`referenceLayers` and never touches files, for the case where the files are already on the
server. The in-app **Datenquellen** upload is a third route, good for a one-off correction.

### 9e. `admin_objects` – Einsatzobjekte + Modul-PDFs

The station's pre-planned objects (a site + its Modul-PDFs, §3c) are station data in the same
sense as the geodata: a `plans/` folder of PDFs plus an `objects.manifest.json` in the private
data repo, loaded with `backend/app/admin_objects.py`. Each object becomes an `ObjectSite` row,
each PDF a `plan:<object-id>:<module>` reference dataset served at `/api/reference/<id>` and
surfaced automatically on an incident near that object.

```bash
# from backend/ – or prefix with `docker compose exec app` on a Docker-only host (§9)
uv run python -m app.admin_objects schema             # the manifest-object JSON Schema
uv run python -m app.admin_objects example            # a sample manifest to edit
uv run python -m app.admin_objects validate <dir>/objects.manifest.json  # + checks every referenced PDF (no DB)
uv run python -m app.admin_objects load <dir>/objects.manifest.json      # upsert objects + copy PDFs (DB + storage)
uv run python -m app.admin_objects push <dir>/objects.manifest.json      # → running deployment (KP_BASE_URL / KP_ADMIN_SECRET)
uv run python -m app.admin_objects show               # print the stored objects + plan counts
```

The manifest is a JSON list of objects, or `{"objects": [...]}`. Per object: **`key` or `id`**
(give one, not neither), `name`, and optionally `address`, `lat`, `lng`, `sourceKey`,
`sourceNote`, plus `plans[]`. Each plan entry needs `module` (the app slot – `modul1` …
`modul6`, or a named Modul-5 sub-slot like `modul5-wasser`; see §3c for what the modules mean)
and `file` (relative to the manifest), and may carry `title`, `sourceNote` and `sha256`.

- **Every object needs a stable identity, and `key` is the one a person should write.** `key`
  is the station's own name for the site (`"key": "schulhaus-dorfmatt"`), hashed to a fixed
  uuid5 that becomes the `id` – so the same key addresses the same Einsatzobjekt from any
  checkout, forever, and retyping it next year *updates* the object. Case and surrounding
  whitespace are ignored. This is what the shipped `objects.manifest.example.json` uses.
- **`id` is the machine form.** A generated manifest (a station importer) writes the uuid5 it
  derived and omits `key`. ⚠️ Never invent a UUID by hand: the upsert matches on `id` and
  nothing else, so one reused or mistyped digit silently creates a *second* object rather than
  updating the first. That is why the example stopped shipping a literal UUID.
- `key` is independent of `sourceKey`, which is what the scheduled plan pull matches on.
- **`sha256`, when present, is verified on every upload** – and `REQUIRE_PLAN_DIGEST` (§6) can
  make declaring it mandatory for machine publishers.
- `load` copies PDFs into the local store (server-side only); `push` uploads them through the
  API so the server writes its own volume. `--dry-run` is available on both.

### 9f. `admin_checklists` – checklist templates

Checklist templates (the FU action list, the Lagerapport agenda, the EL tactical playbook) are
station data too: one `ChecklistTemplate` JSON per list – plus playbook diagram images for
`reference` templates – and a `checklists.manifest.json`, kept in the private data repo and
loaded with `backend/app/admin_checklists.py`. Each template becomes a `checklists:<id>`
reference dataset (diagram pages as `checklists:<id>:p<N>`), served at
`/api/reference/checklists:<id>` and fetched + offline-cached by the Checkliste surface
(`loadTemplates` in `src/lib/checklists.ts`). With nothing loaded, the app falls back to one
neutral bundled example (`src/data/checklists/generic-action.json`) – never a station's real
lists.

```bash
# from backend/ – or prefix with `docker compose exec app` on a Docker-only host (§9)
uv run python -m app.admin_checklists schema             # the manifest-entry JSON Schema
uv run python -m app.admin_checklists example            # a sample manifest to edit
uv run python -m app.admin_checklists validate <dir>/checklists.manifest.json  # + checks every template/asset (no DB)
uv run python -m app.admin_checklists load <dir>/checklists.manifest.json      # upsert templates + assets (writes DB + storage)
uv run python -m app.admin_checklists push <dir>/checklists.manifest.json      # → running deployment (KP_BASE_URL / KP_ADMIN_SECRET)
uv run python -m app.admin_checklists show               # list stored templates + asset counts
```

The manifest is the single place a station controls checklist rail ordering (`order`), and
`load`/`push` **prune** stale `checklists:*` datasets not in the manifest, so renamed or removed
lists don't linger.

### 9g. Maintenance tools (`reset_roster`, `demo_export`)

Two further CLIs that no station meets, but somebody looking after a deployment does. They used
to be documented only in their own docstrings, which nearly cost them their lives twice during
clean-ups – a module nothing imports and no document mentions looks like dead code.

**`reset_roster` – put the user list back to the seed file.** Unlike `seed.py`, which only
creates missing users and never touches an existing PIN, this one *enforces*: it updates every
user from the seed file (display name, role, colour **and** PIN) and deactivates everyone not in
it. Deactivated, not deleted – foreign keys onto incidents, notes and media stay intact, and the
crew list still shows only the seeded people.

```bash
# from backend/ – with the TARGET environment's SECRET_KEY (the PIN pepper) and DATABASE_URL
SECRET_KEY=<target> DATABASE_URL=<target-public> SEED_PIN=<six digits> \
  uv run python -m app.reset_roster
```

The `SECRET_KEY` is not optional: it peppers the PIN hashes. With the wrong one you get a list
nobody can log into.

`SEED_PIN` is not optional either, and it is the same rule as at boot: this tool writes the PIN it
is given onto **every** user in the seed file, and it **refuses one of the well-known PINs**
(`backend/app/auth/security.py · TRIVIAL_PINS`) rather than resetting a station's editor to the
`000000` that ships in `seed_users.json`. The refusal happens before any database work, so a
rejected run changes nothing. Note the consequence of "every user": a seed file carrying distinct
PINs per person collapses to the one you pass – the same thing `seed.py` does at boot.

**`demo_export` – write the demo scene back into the seed file.** The public demo keeps changes
through the day. To rearrange the pre-placed symbols, hose lines or the building, do it live in
the app and then bake the result into `examples/demo-data/incident.workspace.json`:

```bash
DATABASE_URL=<demo Postgres public URL> uv run python -m app.demo_export
```

It only reads; the single thing written is the repo file. The hand-placed keys are kept
(`entities`, `drawings`, `building`, `board`, `layerState`, `recent`) – the collections the
nightly reset recreates anyway (`trupps`, `mittel`, `attendance` …) are dropped, so they do not
freeze into the seed. Commit the result; the nightly reset reads from it.

### 9h. The station workbook – one `.xlsx` for the list-shaped data

Not a CLI, and the reason it sits in this section: for the parts of a station that are simply
**lists**, this is the bulk door, and for several of them it is the only one. `/admin` → Daten →
**Arbeitsmappe** downloads one `.xlsx` holding what the station has today, the station edits it in
whatever it already uses, and uploads it back. Admin session on all three routes; the API shapes
are in [`API.md`](API.md#station-workbook--apistation-workbook).

| Sheet | Writes |
|---|---|
| `Mannschaft` | the personnel rows (name, Grad, provider + external id, active) – **not** config |
| `Dienstgrade` | `roster.ranks` |
| `Fahrzeuge` | `fleet.vehicles` |
| `Mittel` | `mittel.catalogue` |
| `Mittel-Bestände` | `mittel.catalogue[].stock` (the per-source load-out) |
| `Quellen` | `mittel.sources` |
| `Partnerorganisationen` | one `Kategorie` column splitting into `report.partnerOrgs` (`Rapport`) and `fleet.partner.*` (the five others) |
| `Symbolfelder` | `fleet.attributeLists`, one row per option |

**It is upsert only. There is no replace mode and there never will be one** – deleting is
expressible only as a row missing from a sheet that is *present*. Which is why the next two rules
are the whole safety model, and why a volunteer must not have to rediscover either of them.

#### ⚠️ An absent sheet is not an empty sheet

A sheet that is **not in the file** leaves its section exactly as it was. A sheet that **is** in
the file with nothing but its header row **clears** that section. That is deliberate, and it is
how you empty a list on purpose – but it means deleting the `Fahrzeuge` tab to "leave the
vehicles alone" and deleting its rows are two very different acts. The preview says which one it
read: an absent sheet shows «nicht in der Datei – bleibt unverändert» instead of zeros.

#### ⚠️ "Absent" means two different things

A **person** missing from a present `Mannschaft` sheet is **deactivated**, never deleted – closed
incidents resolve their names through that row, so deleting one would rewrite history. An **id**
missing from an id-keyed sheet (`Dienstgrade`, `Fahrzeuge`, `Mittel`, `Quellen`, and the composite
keys behind `Mittel-Bestände`, `Partnerorganisationen`, `Symbolfelder`) is **removed** from the
list. The preview uses those two German words and names the rows rather than counting them.

#### Nothing is written until a preview is confirmed

The upload is planned first and the plan is the confirmation screen: per sheet what would be
created, updated, left alone, removed or deactivated; which sections would end up **empty**; every
warning; and every **refused row with its sheet and row number** (`<Blatt> Zeile <N> – …`, or
`Blatt <Blatt> – …` where the fault is the sheet rather than one row). A single refused row refuses the
whole file – it is all-or-nothing, and nothing is written. The preview reports the SHA-256 of the
bytes it read and the confirm sends it back, so a file edited in between is refused (**409**)
rather than imported against a plan that no longer describes it.

**Re-importing an unmodified export changes nothing at all** – byte-identical config, no personnel
row touched, no history row written. That is the property that makes it safe to download the
workbook just to look at it.

⚠️ **…with one limitation: a config that is already inconsistent exports into a file the import
refuses.** The export writes out whatever the document holds; the import applies the referential
rules above to all of it. Four stored states come back as a refusal you did not cause: a
`catalogue[].stock` entry filed under a `source` that is not in `mittel.sources`; the same id
twice in `roster.ranks`, `fleet.vehicles`, `mittel.catalogue` or `mittel.sources`; two
`report.partnerOrgs`/`fleet.partner.*` names in one category that differ only in case, spacing or
accents (`Zivilschutz` / `zivilschutz`, `Öko` / `Oko`); and any of those lists carrying an **empty
label**. A config written by the forms
or by an earlier workbook import cannot get into those states – a hand-edited or CLI-pushed one
can. **The workbook door stays shut until the config is repaired elsewhere** (Sicherung →
export, edit the JSON, import; or `admin_config`). The row and the reason are named in the
preview, which is where you find out which one it is. (Ids the config *already* holds are
deliberately exempt from the format rule, so an old non-slug `Kennung` is never the cause.)

Every write that *does* change a **config section** keeps the document it replaced, filed under
source `workbook`, so «Letzte Änderungen» undoes that half the same way it undoes a form edit (§9b).

⚠️ **The Mannschaft is not in that safety net.** Personnel are rows in their own table, and
`keep_previous` runs only when a config section actually changed — so an import that touches *only*
the `Mannschaft` sheet writes **no history row at all**, and «Letzte Änderungen» will not show it.
Two things limit what that costs: a person missing from the sheet is **deactivated, not deleted**
(past incidents, notes and media still reference them), so undoing it is a re-activation rather than
a recovery; and the workbook is its own undo — the export you take before an import is the file that
puts the roster back. The one genuinely irreversible edit is a **rename** of a person carrying a
provider identity, which drops the stored first/last split; the preview warns when that would
happen.

#### What it does not cover, and what it will not touch

- **It is not a backup.** It covers list-shaped station data only. The backup is the Sicherung
  JSON export plus «Letzte Änderungen» – [`DEPLOYMENT.md`](DEPLOYMENT.md) §6.
- **`mittel.units` is not in the workbook** and is carried over untouched, as are `identity`,
  `map`, `doctrine`, `referenceLayers`, `modules`, `alarms`, `alarmKeywords`, `report.links` and
  `journal`. A config file is the only way to set `mittel.units`.
- **`mittel.catalogue[].when` and `fleet.vehicles[].winfapAlias` are preserved but not editable.**
  They have no column; they are re-attached on an **id** match. Change a `Kennung` in the sheet and
  the row is a delete plus a create, so those two – and that entry's `stock` – are lost with it.
- **Renaming a person can cost their name order.** Someone who carries a provider identity (a
  Divera id) *and* a stored first/last split loses that split when the sheet renames them, and then
  stops following `roster.nameOrder` – they stand exactly as the cell spells them. The preview
  warns only when this would actually happen.
- **Two referential refusals**, both checked against the state *after* the import, so re-grading
  and dropping in one file is fine: a `Quelle` cannot be dropped while stock still points at it,
  and a `Dienstgrad` cannot be dropped while anybody still carries it – including inactive people.
- **Key cells are read as text or refused, never repaired.** Excel corrupts ids for a living
  (leading zeros, `2-1` becoming a date); a key cell that does not survive that is quoted back at
  you rather than rewritten to something plausible. Formulas cannot leak in either – the file is
  read values-only.
- ⚠️ **`fleet.partner.*` is the legacy shape.** The five non-`Rapport` Partnerkategorien feed the
  `Einheit` suggestion on the partner symbols only as a **fallback**: a `Symbolfelder` row for the
  same symbol and field wins over them. And only `Feuerwehr`, `Sanität` and `Polizei` map to a
  symbol at all – `Chemiewehr` and `Zivilschutz` round-trip faithfully and are read by nothing.
  For anything you want to be certain is live, use the `Symbolfelder` sheet.
- Unknown tabs are **warned about, never silently ignored**; a file that is not `.xlsx` (400), an
  empty one (400) or one over `MAX_UPLOAD_MB` (413) is refused before anything is parsed.

---

## 10. Out of scope for this doc
- **Device preferences** (theme day/night/auto, symbol size) – per-device cookie, not synced.
- **Per-incident settings** (`IncidentSettings`: `contactIntervalMin`, `contactGraceSec`,
  `defaultFunkkanal`) – live in the workspace blob, default from `doctrine` above.
