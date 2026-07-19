# Demo dataset (Musterdorf)

A minimal, **synthetic** dataset for evaluating a fresh KP Front instance — no private station
data, roster, or plans. Two public landmarks anchor the map; the water network is synthetic but
follows the real streets. Safe to commit and to load into a throwaway deployment.

## Contents

| File | What it is | Loaded by |
| --- | --- | --- |
| `config.json` | deployment config: app name, map center (Musterdorf), demo flag, doctrine, and a dummy **Mittel** catalogue | `admin_config` |
| `geodata.manifest.json` + `wasserleitung.geojson` + `hydrant.geojson` | water mains (LineStrings following the streets) + hydrants sampled along them | `admin_geodata` |
| `objects.manifest.json` + `plans/` | Schloss Musterdorf at the prepared alarm address, with synthetic Modul 1, combined Modul 2/3, and three-floor Modul 6 PDFs | `admin_objects` |
| `checklists.manifest.json` + `checklists/` | a demo action list (Aufgaben FU) + tactical Stichworte (no diagram images) | `admin_checklists` |
| `gen_water.py` / `gen_plans.py` | regenerate the water GeoJSON (Overpass street network) / synthetic plan diagrams (reportlab) | (run manually) |
| `load.sh` | loads config + geodata + objects + checklists in order | `just demo-load` |

The `plans/*.pdf` here are **synthetic diagrams**, so taking the prepared Zimmerbrand automatically
shows the object-plan module rail and multi-page floor plans. A real deployment loads its own
Modul-PDFs and real checklists (incl. playbook diagrams) from a private data source
(see [`docs/objektplaene-architecture.md`](../../docs/objektplaene-architecture.md)).

The live demo also seeds a prepared "incoming alarm" (mimicking Divera), a dummy **roster** (12
people), and the two demo login accounts — that's `app.demo_reset` (see `scripts/demo-reset.sh`),
not `load.sh`.

## Load it

```bash
just db          # start the dev Postgres (once)
just demo-load   # load config + water layers + objects + checklists (migrates first)
just api         # backend  → http://localhost:8000
just dev         # frontend → http://localhost:5188
```

Then log in (default editor `fu`, PIN `000000`, from `backend/app/seed_users.json`) and open an
incident at Schloss Musterdorf; the water mains, hydrants, synthetic object plans, and demo
Checklisten will be available.

This is also the empty-state → populated regression path, and the dataset behind the public
demo instance.

To build a real deployment from this structure, keep the replacement data in a separate private
repository and follow the [`station data guide`](../../docs/STATION-DATA.md).
