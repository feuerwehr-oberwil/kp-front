# STATION DATA – configure a brigade deployment

KP Front runs without station data, but a field-ready deployment normally adds its own
branding, map defaults, reference layers, object plans, checklists, and integrations. Keep
that material in a **separate private repository** and load it into the deployment with the
generic tools in this repository.

The private repository is not a KP Front fork or runtime dependency. It is the station's
reviewable source of truth for configuration and licensed or operational data.

> **You do not have to work this way.** Every kind of data below can also be entered in the
> browser at `/admin`, one item at a time – a map layer on **Kartenebenen**, an Einsatzobjekt and
> its Modul-PDFs on **Objektpläne**, a checklist template and its diagram pages on
> **Checklisten**, the config on the Station pages, and the list-shaped data (Mannschaft,
> Dienstgrade, Fahrzeuge, Mittel, Quellen, Partnerorganisationen, Symbolfelder) through the
> **Arbeitsmappe** `.xlsx`. Most stations run entirely that way and never create the repository
> this page describes.
>
> This page is for the other case: **the whole library in one reviewable, repeatable run.** A
> manifest is what you want when the data is licensed and its provenance has to be recorded, when
> a second deployment has to come up identically, when an importer regenerates it from a GIS
> export, or when you want the change reviewed before it is live. The two doors write the same
> rows, so you can mix them.

## Start from the synthetic example

[`examples/demo-data/`](../examples/demo-data/) is the public, working example of the same
pattern. Copy it outside the KP Front repository, replace the synthetic content, and keep the
new repository private:

```text
kp-front-data-muster/
  config.json
  logo.svg                 the brandmark, loaded into the `logo` / `reportLogo` slots
  geodata.manifest.json
  geojson/
  objects.manifest.json
  plans/<object-id>/
  checklists.manifest.json
  checklists/
  load.sh                  the whole sequence, in order (copy examples/demo-data/load.sh)
  scripts/                 optional source-specific importers
```

Use the CLI examples and schemas as the authoritative starting point:

```bash
cd backend
uv run python -m app.admin_config example
uv run python -m app.admin_geodata example
uv run python -m app.admin_objects example
uv run python -m app.admin_checklists example
```

(`admin_branding` has no `example`/`schema` – its input is an image file. Its five slots are
`logo`, `reportLogo`, `favicon`, `iconPng192` and `iconPng512`; the last two are the installed
app's home-screen icons and must be square PNGs – [`CONFIGURATION.md` §3a](CONFIGURATION.md).)

The complete field contract, including accepted properties and formats, is in
[`CONFIGURATION.md`](CONFIGURATION.md).

## What belongs in the private repository

| Data | Typical source | KP Front input (as-code) | The browser instead |
| --- | --- | --- | --- |
| Identity, map, fleet, doctrine, Dienstgrade | Station decisions | `config.json` | the Station pages; Dienstgrade + Fahrzeuge also via the **Arbeitsmappe** |
| Brandmark and Rapport letterhead | The Wehr's own logo | SVG or PNG, loaded per slot with `admin_branding` | Station › Station & Karte |
| Hydrants and utility layers | GIS exports, WFS/WMS, open data | WGS84 GeoJSON + `geodata.manifest.json` | Station › **Kartenebenen** (one layer; a replace bumps the version in place) |
| Einsatzobjekte | Object register or plan library | `objects.manifest.json` | Station › **Objektpläne** (no UUID typed – see below) |
| Object plans | Approved pre-incident plans | PDF files referenced by the object manifest | Station › **Objektpläne**, per Modul slot |
| Checklists and playbooks | Station doctrine | Template JSON, optional images, and `checklists.manifest.json` | Station › **Checklisten**, incl. diagram assets and deletion |
| Mittel, Quellen, Partnerorganisationen, Symbolfeld-Optionen | Station decisions | `config.json` | the **Arbeitsmappe** `.xlsx` – there is no form for these ([`CONFIGURATION.md` §9h](CONFIGURATION.md#9h-the-station-workbook--one-xlsx-for-the-list-shaped-data)) |
| Mannschaft | Divera sync, or the station's own list | – **personal data: keep it out of the repo unless the repo is as protected as the roster is** | Divera sync, a CSV import, or the **Arbeitsmappe** ([`CONFIGURATION.md`](CONFIGURATION.md) §4a/§4b) |
| Source adapters | GIS, DMS, or roster-specific APIs | Optional scripts maintained by the station | – |

Do not copy restricted data into KP Front itself. Record the source, licence, refresh owner,
and refresh frequency in the private repository. Source-specific importers also belong there;
the public app only defines and validates their output formats.

## Validate before loading

Validation is offline and does not change a deployment:

```bash
cd backend
uv run python -m app.admin_config validate ../../kp-front-data-muster/config.json
uv run python -m app.admin_geodata validate ../../kp-front-data-muster/geodata.manifest.json
uv run python -m app.admin_objects validate ../../kp-front-data-muster/objects.manifest.json
uv run python -m app.admin_checklists validate ../../kp-front-data-muster/checklists.manifest.json
```

Important boundaries:

- Map GeoJSON must use WGS84 `[longitude, latitude]`. The app never reprojects: LV95-looking
  coordinates are **rejected**, so convert them in your own importer first.
- Every manifest path is relative to its manifest file.
- IDs must remain stable across refreshes so objects and layers update in place.
- **The two doors address the same Einsatzobjekt.** Nobody types a UUID on either. The browser
  form on **Objektpläne** takes the same human `key` a manifest does (`schulhaus-dorfmatt`) and
  hashes it to the identical uuid5 the CLI derives, showing the derived id live – so an object
  created in the browser is *updated* by a later manifest run carrying the same key, and not
  duplicated. Case and surrounding whitespace are ignored on both sides.
- Only data that the station may redistribute to its operators should be loaded.

## Load it – `load` server-side, `push` from anywhere

**The order matters in one place: branding after the config, never before** – why, in
[`CONFIGURATION.md` §9a](CONFIGURATION.md#9a-what-all-of-them-share). Everything after that is
independent.

[`examples/demo-data/load.sh`](../examples/demo-data/load.sh) is the worked version of exactly
this sequence – copy it as the skeleton of your station's own load script:

```text
1  admin_config      config.json
2  admin_branding    logo / reportLogo        ← after the config, never before
3  admin_geodata     geodata.manifest.json
4  admin_objects     objects.manifest.json
5  admin_checklists  checklists.manifest.json
6  seed_personnel    (or a CSV import in /admin – the crew, so Anwesenheit has people)
```

Which verb belongs where is [`CONFIGURATION.md`
§9a](CONFIGURATION.md#9a-what-all-of-them-share); below is what each one looks like.

### On the deployment host (`load`)

```bash
cd backend
uv run python -m app.admin_config     load ../../kp-front-data-muster/config.json
uv run python -m app.admin_branding   load logo       ../../kp-front-data-muster/logo.svg
uv run python -m app.admin_branding   load reportLogo ../../kp-front-data-muster/report-logo.svg
uv run python -m app.admin_geodata    load ../../kp-front-data-muster/geodata.manifest.json
uv run python -m app.admin_objects    load ../../kp-front-data-muster/objects.manifest.json
uv run python -m app.admin_checklists load ../../kp-front-data-muster/checklists.manifest.json
```

### From a workstation (`push`)

**Postgres is deliberately not reachable from outside the compose network**, so there is no
"connect to the deployment database from your laptop" path. Use `push` – all five CLIs have it.

```bash
export KP_BASE_URL=https://kp-front.example.ch
export KP_ADMIN_SECRET='<deployment admin secret>'

cd backend
uv run python -m app.admin_config     push ../../kp-front-data-muster/config.json
uv run python -m app.admin_branding   push logo       ../../kp-front-data-muster/logo.svg
uv run python -m app.admin_branding   push reportLogo ../../kp-front-data-muster/report-logo.svg
uv run python -m app.admin_geodata    push ../../kp-front-data-muster/geodata.manifest.json
uv run python -m app.admin_objects    push ../../kp-front-data-muster/objects.manifest.json
uv run python -m app.admin_checklists push ../../kp-front-data-muster/checklists.manifest.json
```

`push --dry-run` authenticates and reports without writing. `admin_config` refuses a push that
would **empty** a section that currently has content – that is what publishing a stale file looks
like – and `--force` is how you say you meant it. Every write keeps the document it replaced;
`admin_config history` / `restore <id>` is the way back. Details:
[`CONFIGURATION.md`](CONFIGURATION.md) §9.

`/admin` writes the same rows through forms and uploads, and most stations do everything there.
Object plans, geodata and checklists are **no longer terminal-only** – each has its own admin page
for a single item, and the two doors are interchangeable. This repository is for the parts that
want to be reviewable and repeatable: the whole library in one run, a manifest an importer
regenerates, a second deployment that has to come up identically, and the handful of fields no
form exposes (a layer's `nightColor` / `opacity` / `maxzoom` / `symbol` / `autoActivate`,
`mittel.units`, `alarmKeywords`, `mittel.catalogue[].when`, `fleet.vehicles[].winfapAlias`).
Never commit database URLs, admin secrets, API credentials, personal rosters, or operational data
to the public repository.

## Definition of ready

⚠️ **Ready is not the same as complete.** Nothing below asks for a full inventory, and none of
these lists has to be finished before the app is worth running – see *You do not owe anyone a
complete inventory* in [`SETUP.md`](SETUP.md) §4. A station with a dozen Mittel, four vehicles
and the handful of objects it actually gets sent to is ready; the rest arrives when a real
Einsatz shows what was missing.

A technical owner should be able to confirm all of the following:

- `/ready` reports both database and storage as healthy.
- `/api/config` shows the intended station identity and map defaults.
- A known hydrant or reference feature appears at the expected location.
- An incident at a known object offers the correct plans.
- Station checklists open and remain available after preparing the device for offline use.
- The initial editor PIN and `ADMIN_SECRET` have been changed from setup defaults.
- Data provenance, permissions, refresh commands, and recovery ownership are documented privately.

This is the same boundary used by an operational station deployment: public application code,
private station inputs, repeatable validation, and an explicit load or push step.
