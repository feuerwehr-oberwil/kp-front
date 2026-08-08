# Demo dataset (Musterdorf)

A minimal, **synthetic** dataset for evaluating a fresh KP Front instance – no private station
data, roster, or plans. Two public landmarks anchor the map; the water network is synthetic but
follows the real streets. Safe to commit and to load into a throwaway deployment.

## Contents

| File | What it is | Loaded by |
| --- | --- | --- |
| `config.json` | deployment config: app name, map center (Musterdorf), demo flag, doctrine, and a dummy **Mittel** catalogue | `admin_config` |
| `geodata.manifest.json` + `wasserleitung.geojson` + `hydrant.geojson` | water mains (LineStrings following the streets) + hydrants sampled along them | `admin_geodata` |
| `objects.manifest.json` + `plans/` | Schloss Musterdorf at the prepared alarm address, with a hand-drawn Modul 1 (Übersicht) and combined Modul 2/3 (Zugang & Objekt) | `admin_objects` |
| `checklists.manifest.json` + `checklists/` | a demo action list (Aufgaben FU) + tactical Stichworte (no diagram images) | `admin_checklists` |
| `report-logo.png` | the Musterdorf brandmark – login screen (`logo`) and the printed rapport's letterhead (`reportLogo`) | `admin_branding load` |
| `gen_water.py` | regenerate the water GeoJSON from the Overpass street network | (run manually) |
| `load.sh` | loads config + brandmark + geodata + objects + checklists in order | `just demo-load` |

The `plans/*.pdf` here are **synthetic sheets**, so taking the prepared Zimmerbrand automatically
shows the object-plan module rail. There is no Modul 6 (Geschosspläne) in the demo dataset — the
slot exists in the app, this object simply has no sheet for it. A real deployment loads its own
Modul-PDFs and real checklists (incl. playbook diagrams) from a private data source
(see [`docs/objektplaene-architecture.md`](../../docs/objektplaene-architecture.md)).

`load.sh` seeds the synthetic **Mannschaft** (12 people, so Anwesenheit and Schichtenplanung have
someone to work with) but no incident and no alarm – you start those yourself. The live demo goes
further and seeds a pre-filled *running* incident plus the two demo login accounts – that's
`app.demo_reset` (see `scripts/demo-reset.sh`), not `load.sh`.

## Load it

```bash
just demo-load   # config + logo + water layers + objects + checklists + crew (starts the DB, migrates)
just demo-off    # REQUIRED: the dataset sets demoMode, which blocks creating incidents (403)
just dev         # database + backend (:8001) + frontend (:5188)
```

`config.json` ships `demoMode: true` because this is also the dataset behind the public demo,
where creating incidents must be refused. Locally that guard just looks like a broken app, so
`just demo-off` clears it — re-run it after every `just demo-load`.

Then log in (default editor `fu`, PIN `000000`, from `backend/app/seed_users.json`) and open an
incident at Schloss Musterdorf; the water mains, hydrants, synthetic object plans, and demo
Checklisten will be available.

This is also the empty-state → populated regression path, and the dataset behind the public
demo instance.

To build a real deployment from this structure, keep the replacement data in a separate private
repository and follow the [`station data guide`](../../docs/STATION-DATA.md).
