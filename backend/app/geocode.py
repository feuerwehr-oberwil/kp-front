"""swisstopo geocoder (api3.geo.admin.ch) — address → WGS84 lat/lng.

Biased to the brigade's region so a bare street name resolves locally instead of to a
same-named street elsewhere in CH (e.g. a street name → the home region, not a far canton):
- append a default locality when the address carries no 4-digit postal code, and
- sort results by a regional bbox (sortbbox) so local hits rank first.

The bias (locality + bbox) is read from the deployment config (``map.geocoder`` in the
admin-edited ``DeploymentConfig`` singleton) first, falling back to the ``geocoder_*``
settings when the config is absent/empty. With no config and empty settings the search is
unbiased (national) — a fresh/public deployment behaves neutrally.

`geocode()` returns the single best match (used on manual create and Divera take when
coords are missing); `search()` returns a ranked list for the intake autocomplete. Both
return empty/None on no match or upstream failure (caller falls back to map-click).
"""

import logging
import re
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select

from .config import settings

logger = logging.getLogger(__name__)

_HAS_PLZ = re.compile(r"\b\d{4}\b")
_TAGS = re.compile(r"<[^>]+>")  # swisstopo labels arrive with <b>…</b> highlight markup

# SSRF defence-in-depth: the geocoder endpoint is config-driven (not user input), but pin
# it to https + its own host so a mis-set/overridden settings.geocoder_url can't be turned
# into a request against an arbitrary internal address. Low risk, cheap guard.
_GEOCODER_SPLIT = urlsplit(settings.geocoder_url)
_GEOCODER_OK = _GEOCODER_SPLIT.scheme == "https" and bool(_GEOCODER_SPLIT.hostname)


@dataclass(frozen=True)
class GeoHit:
    label: str
    lat: float
    lng: float


# Cache the resolved bias briefly so every keystroke in the intake autocomplete doesn't
# re-query the DeploymentConfig singleton. Short TTL → an admin config edit takes effect
# within a minute without a restart.
_BIAS_TTL_SECONDS = 60.0
_bias_cache: tuple[float, tuple[str, str]] | None = None


async def _resolve_bias() -> tuple[str, str]:
    """(default_locality, bbox_lv95), config-first then settings.

    Reads ``map.geocoder.defaultLocality`` / ``map.geocoder.bboxLv95`` from the
    ``DeploymentConfig`` singleton (id=1) when present and non-empty, else falls back to
    ``settings.geocoder_default_locality`` / ``settings.geocoder_bbox_lv95``. Never raises:
    any DB/lookup failure degrades to settings so the geocoder never 500s.
    """
    global _bias_cache
    now = time.monotonic()
    if _bias_cache is not None and now - _bias_cache[0] < _BIAS_TTL_SECONDS:
        return _bias_cache[1]

    locality = settings.geocoder_default_locality
    bbox = settings.geocoder_bbox_lv95
    try:
        # Imported lazily to avoid a circular import at module load and to keep geocode
        # importable in contexts without a configured DB.
        from .database import async_session_maker
        from .models import DeploymentConfig

        async with async_session_maker() as db:
            row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        cfg = (row.config_json or {}) if row else {}
        geo = ((cfg.get("map") or {}).get("geocoder") or {}) if isinstance(cfg, dict) else {}
        cfg_locality = str(geo.get("defaultLocality") or "").strip()
        cfg_bbox = str(geo.get("bboxLv95") or "").strip()
        if cfg_locality:
            locality = cfg_locality
        if cfg_bbox:
            bbox = cfg_bbox
    except Exception as e:  # noqa: BLE001 — never let config lookup break geocoding
        logger.warning("Geocoder bias config lookup failed; using settings defaults: %s", e)

    _bias_cache = (now, (locality, bbox))
    return locality, bbox


def _bias(text: str, default_locality: str) -> str:
    """Append the home locality when the operator typed only a street.

    ⚠️ Only when they have not started on a locality themselves. A postal code is four digits,
    so a half-typed one («…, 410») did not match `_HAS_PLZ` and the home locality was appended
    ANYWAY — the query became «storchenweg 8, 410 4103 Bottmingen», two localities at once, and
    swisstopo answered by matching the numbers and dropping the street name entirely: six hits
    in the wrong village, none of them a Storchenweg. Anything after a comma is the operator
    writing the locality part themselves, so we leave the query alone and let the regional bbox
    do the biasing (which resolves this exact query correctly on its own).
    """
    if not default_locality or _HAS_PLZ.search(text):
        return text
    if "," in text and text.rsplit(",", 1)[1].strip():
        return text
    return f"{text} {default_locality}"


def _home_first(hits: list[GeoHit], default_locality: str) -> list[GeoHit]:
    """Stable re-rank: addresses in the brigade's own town first.

    The regional bbox biases to the REGION, which for a small brigade holds several villages —
    so a street name that exists in two of them could answer with the neighbour's first. The
    town we are standing in is the likelier answer to «where is it», and everything else keeps
    swisstopo's own order behind it.
    """
    tokens = [t.strip().lower() for t in default_locality.split() if t.strip()]
    if not tokens:
        return hits

    def home(h: GeoHit) -> bool:
        label = h.label.lower()
        return any(t in label for t in tokens)

    return [h for h in hits if home(h)] + [h for h in hits if not home(h)]


def _parse(results: list[dict]) -> list[GeoHit]:
    hits: list[GeoHit] = []
    for r in results:
        attrs = r.get("attrs", {})
        lat, lon = attrs.get("lat"), attrs.get("lon")
        if lat is None or lon is None:
            continue
        raw = attrs.get("label") or attrs.get("detail") or ""
        label = _TAGS.sub("", raw).strip()
        hits.append(GeoHit(label=label, lat=float(lat), lng=float(lon)))
    return hits


async def search(address: str, limit: int = 6) -> list[GeoHit]:
    """Region-biased address search → ranked hits (best first). Empty on failure."""
    if not address or not address.strip():
        return []
    if not _GEOCODER_OK:
        logger.warning("Geocoder URL is not a valid https endpoint; skipping geocode")
        return []
    default_locality, bbox = await _resolve_bias()
    base = {
        "type": "locations",
        "searchText": _bias(address.strip(), default_locality),
        "sr": "2056",  # LV95 — so the regional bbox is in metres
        "limit": str(max(1, min(limit, 20))),
        "origins": "address,parcel,gg25",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Pass 1: bias to the region when a bbox is configured. ⚠️ swisstopo's `bbox` is a
            # hard geographic filter on the SearchServer, not merely a ranking hint (docs/
            # CONFIGURATION.md's own "to rank local hits" comment notwithstanding) — nothing
            # outside it comes back from this pass, `sortbbox` only orders what's inside.
            params1 = {**base}
            if bbox:
                params1 = {**base, "bbox": bbox, "sortbbox": "true"}
            r = await client.get(settings.geocoder_url, params=params1)
            r.raise_for_status()
            results = r.json().get("results", [])
            # Pass 2: fill the rest nationally. ⚠️ 05.09. fix — this used to fire only when
            # pass 1 came back COMPLETELY empty, on the assumption that any local hit meant the
            # region had answered. It hadn't: a query for a genuinely out-of-region address
            # (Muttenz, searched from the Oberwil deployment) can still turn up a loose local
            # match — a same-named street, a parcel — that fills `results` without being what
            # was typed, and the real answer never got a second pass. Mutual-aid addresses are
            # real, so this now runs whenever the region hasn't already filled the request,
            # merging in whatever the region pass missed (deduped by coordinate, region first)
            # rather than replacing it — a partial local match still belongs at the top.
            if bbox and len(results) < limit:
                r = await client.get(settings.geocoder_url, params=base)
                r.raise_for_status()
                extra = r.json().get("results", [])
                seen = {(a["lat"], a["lon"]) for res in results if (a := res.get("attrs", {})) and "lat" in a}
                results = results + [
                    res for res in extra
                    if (a := res.get("attrs", {})) and "lat" in a and (a["lat"], a["lon"]) not in seen
                ]
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("Geocode failed for %r: %s", address, e)
        return []
    return _home_first(_parse(results), default_locality)[:limit]


async def geocode(address: str) -> tuple[float, float] | None:
    """Single best-match coordinate, or None. Thin wrapper over search()."""
    hits = await search(address, limit=1)
    if not hits:
        return None
    return hits[0].lat, hits[0].lng


# Reverse geocode runs against the same geo.admin host (SSRF-pinned like the SearchServer
# above) but the MapServer/identify service, hitting the official building-address register
# (GWR). Lets a map-click on the intake wizard auto-fill the nearest address.
_IDENTIFY_URL = f"{_GEOCODER_SPLIT.scheme}://{_GEOCODER_SPLIT.hostname}/rest/services/api/MapServer/identify"
_ADDR_LAYER = "ch.bfs.gebaeude_wohnungs_register"


def _label_from_gwr(attrs: dict) -> str | None:
    """Compose "Strasse Nr, PLZ Ort" from GWR feature attributes.

    The register exposes a ready-made `strname_deinr` ("Hohlegasse 3"), a `plz_plz6`
    ("4104/410400" → take the 4-digit PLZ) and `ggdename` ("Musterort (BL)" → drop the
    cantonal suffix). Falls back to the split street-name list + house number.
    """
    street = str(attrs.get("strname_deinr") or "").strip()
    if not street:
        sn = attrs.get("strname")
        if isinstance(sn, list):
            sn = sn[0] if sn else ""
        street = " ".join(p for p in (str(sn or "").strip(), str(attrs.get("deinr") or "").strip()) if p)
    plz6 = str(attrs.get("plz_plz6") or "")
    plz = plz6.split("/")[0].strip() if plz6 else str(attrs.get("dplz4") or attrs.get("plz4") or "").strip()
    ort = str(attrs.get("ggdename") or attrs.get("gdename") or attrs.get("dplzname") or "").strip()
    ort = re.sub(r"\s*\([^)]*\)\s*$", "", ort)  # drop the "(BL)" canton suffix
    line2 = " ".join(p for p in (plz, ort) if p).strip()
    label = ", ".join(p for p in (street.strip(), line2) if p).strip()
    return label or None


async def reverse(lat: float, lng: float) -> GeoHit | None:
    """Nearest registered address to a WGS84 point, or None. Degrades silently."""
    if not _GEOCODER_OK:
        logger.warning("Geocoder URL is not a valid https endpoint; skipping reverse geocode")
        return None
    # A small WGS84 window around the point satisfies the identify API's required
    # mapExtent/imageDisplay; tolerance widens the hit radius so a click near a building
    # still snaps to its address.
    d = 0.0015
    params = {
        "geometry": f"{lng},{lat}",
        "geometryType": "esriGeometryPoint",
        "geometryFormat": "geojson",
        "sr": "4326",
        "tolerance": "60",
        "mapExtent": f"{lng - d},{lat - d},{lng + d},{lat + d}",
        "imageDisplay": "500,500,96",
        "layers": f"all:{_ADDR_LAYER}",
        "returnGeometry": "false",
        "lang": "de",
        "limit": "1",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(_IDENTIFY_URL, params=params)
            r.raise_for_status()
            results = r.json().get("results", [])
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("Reverse geocode failed for %s,%s: %s", lat, lng, e)
        return None
    for feat in results:
        label = _label_from_gwr(feat.get("attributes", {}) or feat.get("properties", {}) or {})
        if label:
            return GeoHit(label=label, lat=lat, lng=lng)
    return None
