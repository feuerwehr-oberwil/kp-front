"""Small geo helpers (no external deps)."""

import math


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def lv95_to_wgs84(east: float, north: float) -> tuple[float, float]:
    """Approximate LV95 (EPSG:2056) → WGS84 (lat, lng), swisstopo's closed-form formula.

    Accurate to a few metres — ample for both of its callers: the nearest-SMN-station lookup
    (weather) and the ``§GEO`` markers a plan author writes in LV95 (plan_markers).
    """
    y = (east - 2_600_000.0) / 1_000_000.0
    x = (north - 1_200_000.0) / 1_000_000.0
    lng = (2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y) * 100.0 / 36.0
    lat = (
        (16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x * x * x)
        * 100.0
        / 36.0
    )
    return lat, lng
