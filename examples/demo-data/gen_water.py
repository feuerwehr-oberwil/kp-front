#!/usr/bin/env python3
"""Generate the demo water network (synthetic) that FOLLOWS the real streets around the two
demo objects — Feuerwehr Musterdorf and Schloss Musterdorf. Pulls the OSM street geometry via
Overpass, keeps the streets near each POI, and emits:

  wasserleitung.geojson  — water mains as LineStrings (the street geometry = pipes under roads)
  hydrant.geojson        — hydrants sampled along those mains

Run once to (re)generate; the committed .geojson files are what the demo actually loads.

    uv run python examples/demo-data/gen_water.py     # from repo root, or just run with python3

Deterministic (no RNG seeded by clock) so re-runs are stable in git.
"""

import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The two demo objects — pipes/hydrants cluster around these (geocoded addresses).
POIS = [
    ("Feuerwehr Musterdorf", 47.51643, 7.56195),   # Feuerwehrstrasse 1, 4104 Musterdorf
    ("Schloss Musterdorf", 47.52382, 7.57037),  # Schlossgasse 9, 4104 Musterdorf
]
RADIUS_M = 430           # keep streets whose vertices fall within this of a POI
HYDRANT_SPACING_M = 150  # place a hydrant roughly every N metres along a main

# bbox covering both towns (S, W, N, E)
BBOX = (47.510, 7.552, 47.531, 7.590)


def haversine(a_lat, a_lon, b_lat, b_lon):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def near_poi(lat, lon):
    return any(haversine(lat, lon, plat, plon) <= RADIUS_M for _, plat, plon in POIS)


def fetch_streets():
    s, w, n, e = BBOX
    kinds = "residential|tertiary|secondary|primary|unclassified|living_street"
    q = (
        f"[out:json][timeout:60];"
        f'(way["highway"~"{kinds}"]({s},{w},{n},{e}););'
        f"out geom;"
    )
    mirrors = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://lz4.overpass-api.de/api/interpreter",
    ]
    last = None
    for _ in range(2):
        for url in mirrors:
            try:
                req = urllib.request.Request(
                    url,
                    data=urllib.parse.urlencode({"data": q}).encode(),
                    headers={"User-Agent": "kp-front-demo-datagen"},
                )
                with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310 — trusted public API
                    return json.load(r)["elements"]
            except Exception as e:  # noqa: BLE001 — try the next mirror
                last = e
                print(f"  (mirror {url} failed: {e}; trying next)")
    raise RuntimeError(f"all Overpass mirrors failed: {last}")


def main() -> int:
    elements = fetch_streets()

    pipes = []       # list of coordinate lists ([[lon,lat],...])
    seen_names = {}
    for el in elements:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        pts = [(p["lat"], p["lon"]) for p in el["geometry"]]
        if not any(near_poi(la, lo) for la, lo in pts):
            continue
        # Keep the full way (it visibly follows the street). Dedupe identical names lightly
        # so a long multi-segment street doesn't spam dozens of near-identical pipes.
        name = el.get("tags", {}).get("name", f"w{el['id']}")
        seen_names[name] = seen_names.get(name, 0) + 1
        pipes.append([[round(lo, 6), round(la, 6)] for la, lo in pts])

    # --- Wasserleitungen (LineStrings) ---
    pipe_features = [
        {
            "type": "Feature",
            "properties": {"art": "Versorgungsleitung", "nr": f"WL-{i + 1:03d}"},
            "geometry": {"type": "LineString", "coordinates": coords},
        }
        for i, coords in enumerate(pipes)
        if len(coords) >= 2
    ]

    # --- Hydrants sampled along the mains ---
    hydrants = []
    hnum = 0
    for coords in pipes:
        acc = 0.0
        # always drop one at the start of each main
        drop_next = 0.0
        for (lo1, la1), (lo2, la2) in zip(coords, coords[1:]):
            seg = haversine(la1, lo1, la2, lo2)
            if seg == 0:
                continue
            pos = 0.0
            while acc + (seg - pos) >= drop_next:
                need = drop_next - acc
                t = (pos + need) / seg
                hlat = la1 + (la2 - la1) * t
                hlon = lo1 + (lo2 - lo1) * t
                hnum += 1
                kind = "Überflurhydrant" if hnum % 3 else "Unterflurhydrant"
                hydrants.append((round(hlon, 6), round(hlat, 6), kind, hnum))
                pos = pos + need
                acc = drop_next
                drop_next += HYDRANT_SPACING_M
            acc += seg - pos

    # de-dupe hydrants that land on shared street vertices (within ~15 m)
    uniq = []
    for lo, la, kind, _ in hydrants:
        if all(haversine(la, lo, u[1], u[0]) > 15 for u in uniq):
            uniq.append((lo, la, kind, len(uniq) + 1))
    hydrant_features = [
        {
            "type": "Feature",
            "properties": {"art": kind, "nr": f"H-{n:03d}"},
            "geometry": {"type": "Point", "coordinates": [lo, la]},
        }
        for lo, la, kind, n in uniq
    ]

    (HERE / "wasserleitung.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": pipe_features}, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    (HERE / "hydrant.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": hydrant_features}, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    print(f"✓ {len(pipe_features)} Wasserleitungen, {len(hydrant_features)} Hydranten around {len(POIS)} POIs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
