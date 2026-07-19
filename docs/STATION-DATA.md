# STATION DATA — configure a brigade deployment

KP Front runs without station data, but a field-ready deployment normally adds its own
branding, map defaults, reference layers, object plans, checklists, and integrations. Keep
that material in a **separate private repository** and load it into the deployment with the
generic tools in this repository.

The private repository is not a KP Front fork or runtime dependency. It is the station's
reviewable source of truth for configuration and licensed or operational data.

## Start from the synthetic example

[`examples/demo-data/`](../examples/demo-data/) is the public, working example of the same
pattern. Copy it outside the KP Front repository, replace the synthetic content, and keep the
new repository private:

```text
kp-front-data-muster/
  config.json
  geodata.manifest.json
  geojson/
  objects.manifest.json
  plans/<object-id>/
  checklists.manifest.json
  checklists/
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

The complete field contract, including accepted properties and formats, is in
[`CONFIGURATION.md`](CONFIGURATION.md).

## What belongs in the private repository

| Data | Typical source | KP Front input |
| --- | --- | --- |
| Identity, map, fleet, doctrine | Station decisions | `config.json` |
| Hydrants and utility layers | GIS exports, WFS/WMS, open data | WGS84 GeoJSON + `geodata.manifest.json` |
| Einsatzobjekte | Object register or plan library | `objects.manifest.json` |
| Object plans | Approved pre-incident plans | PDF files referenced by the object manifest |
| Checklists and playbooks | Station doctrine | Template JSON, optional images, and `checklists.manifest.json` |
| Source adapters | GIS, DMS, or roster-specific APIs | Optional scripts maintained by the station |

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

- Map GeoJSON must use WGS84 `[longitude, latitude]`; LV95 is converted before loading.
- Every manifest path is relative to its manifest file.
- IDs must remain stable across refreshes so objects and layers update in place.
- Only data that the station may redistribute to its operators should be loaded.

## Load a local or server-side deployment

When the commands run where `DATABASE_URL` and the asset storage point at the deployment,
use `load`:

```bash
cd backend
uv run python -m app.admin_config load ../../kp-front-data-muster/config.json
uv run python -m app.admin_geodata load ../../kp-front-data-muster/geodata.manifest.json
uv run python -m app.admin_objects load ../../kp-front-data-muster/objects.manifest.json
uv run python -m app.admin_checklists load ../../kp-front-data-muster/checklists.manifest.json
```

For a remote deployment, geodata, plans, and checklists can be sent through the running API.
This ensures files are written to the server's own storage volume:

```bash
export KP_BASE_URL=https://kp-front.example.ch
export KP_ADMIN_SECRET='<deployment admin secret>'

cd backend
uv run python -m app.admin_geodata push ../../kp-front-data-muster/geodata.manifest.json
uv run python -m app.admin_objects push ../../kp-front-data-muster/objects.manifest.json
uv run python -m app.admin_checklists push ../../kp-front-data-muster/checklists.manifest.json
```

Load the main `config.json` through a deployment database connection, or make supported basic
changes in `/admin`. Branding assets are uploaded in `/admin`. Never commit database URLs,
admin secrets, API credentials, personal rosters, or operational data to the public repository.

## Definition of ready

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
