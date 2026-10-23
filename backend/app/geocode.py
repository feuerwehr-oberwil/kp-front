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
coords are missing); `locate()` is the strict twin for station OBJECTS (exact street + number in
the brigade's area, never a fuzzy neighbour — see its block below); `search()` returns a ranked list for the intake autocomplete. Both
return empty/None on no match or upstream failure (caller falls back to map-click). A miss is
retried once with a typo-corrected street name (see street_dictionary) when a bbox is set.
"""

import logging
import re
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select

from .config import settings
from .street_dictionary import StreetDictionary, correct_query

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


_WORD = re.compile(r"[a-z0-9]+")


def _words(text: str) -> list[str]:
    """Folded words of a query or label: lower case, accents off, «ue»/«oe»/«ae» as typed for ü/ö/ä."""
    folded = _fold(text).replace("ue", "u").replace("oe", "o").replace("ae", "a")
    return _WORD.findall(folded)


def _shares_a_word(hits: list[GeoHit], query: str) -> list[GeoHit]:
    """Only the hits whose label shares a word with what the operator typed (the first three
    letters of a word are enough – a half-typed or misspelt street still counts).

    ⚠️ Sweep F.3 (23.10.2026): `_bias` appends the home locality, and swisstopo drops a token it
    cannot place, so «xyzqq» went out as «xyzqq 4104 Oberwil» and came back as six real Oberwil
    addresses – plausible wrong pins under «Adressen» at 3am. Words shorter than three letters
    (house numbers, «41») do not count; a query made only of those is left unfiltered.
    """
    wanted = [w[:3] for w in _words(query) if len(w) >= 3]
    if not wanted:
        return hits
    return [h for h in hits if any(w.startswith(p) for w in _words(h.label) for p in wanted)]


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


async def _upstream(text: str, bbox: str, limit: int) -> list[dict]:
    """The two-pass SearchServer query for one search text: region first, then national fill.

    Raises httpx/ValueError – `search` turns that into an empty answer.
    """
    base = {
        "type": "locations",
        "searchText": text,
        "sr": "2056",  # LV95 — so the regional bbox is in metres
        "limit": str(max(1, min(limit, 20))),
        "origins": "address,parcel,gg25",
    }
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
            # .get for BOTH keys: a result carrying lat without lon would otherwise KeyError
            # past the httpx/ValueError net below and 500 the whole create.
            seen = {(a.get("lat"), a.get("lon")) for res in results if (a := res.get("attrs", {})) and "lat" in a}
            results = results + [
                res
                for res in extra
                if (a := res.get("attrs", {})) and "lat" in a and (a.get("lat"), a.get("lon")) not in seen
            ]
    return results


async def search(address: str, limit: int = 6) -> list[GeoHit]:
    """Region-biased address search → ranked hits (best first). Empty on failure.

    A query that finds nothing is retried once with its street token corrected against the
    region's street dictionary («haupstrasse 12» → «Hauptstrasse 12»), when exactly one known
    street is a single edit away – see street_dictionary. The hits carry swisstopo's label,
    i.e. the corrected spelling. A hit that shares no word with the query is dropped
    (`_shares_a_word`): the appended home locality must not answer for a query that named nothing.
    """
    if not address or not address.strip():
        return []
    if not _GEOCODER_OK:
        logger.warning("Geocoder URL is not a valid https endpoint; skipping geocode")
        return []
    default_locality, bbox = await _resolve_bias()
    query = address.strip()
    try:
        results = await _upstream(_bias(query, default_locality), bbox, limit)
        if not results and (streets := _streets.get(bbox)) and (fixed := correct_query(query, streets)):
            logger.info("Geocode retry with corrected street: %r → %r", query, fixed)
            query = fixed
            results = await _upstream(_bias(fixed, default_locality), bbox, limit)
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("Geocode failed for %r: %s", address, e)
        return []
    return _home_first(_shares_a_word(_parse(results), query), default_locality)[:limit]


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

# The street dictionary behind `search`'s typo retry reads the Strassenverzeichnis through the
# same identify service, for the bbox the search is biased to.
_streets = StreetDictionary(_IDENTIFY_URL)


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


# --- an object's place: exact street + number, in the brigade's area -----------------------------
#
# `geocode()` above is right for an Einsatz: the operator typed an address a moment ago and looks
# at the pin it gives. It is WRONG for a catalogue object, which is geocoded once, unattended, and
# then drawn on the station's map for years. «Erlenstrasse 60» (ARA Birsig, review 17.10.2026)
# carried no town; `_bias` appended the home locality, swisstopo had no Erlenstrasse in Oberwil
# and answered with its nearest fuzzy neighbour, «Vorderbergstrasse 60, 4104 Oberwil» — 1.1 km
# from the real place in Therwil, and nothing said so. `locate` takes only an EXACT street +
# number, prefers the home town, accepts exactly one match elsewhere in the brigade's area (the
# region bias's bbox) and calls several of them ambiguous instead of picking one.

_PLZ_TOWN = re.compile(r"^(?P<street>.*?)[\s,]+(?P<plz>\d{4})\s+(?P<town>.+)$")
_CANTON_SUFFIX = re.compile(r"\s*(\([A-Z]{2}\)|\b[A-Z]{2})\s*$")


def _fold(s: str) -> str:
    import unicodedata

    folded = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in folded if not unicodedata.combining(c))


def street_key(text: str | None) -> str:
    """«Mühlemattstr. 18», «Muehlemattstrasse 18, 4104 Oberwil» → «muhlemattstrasse18» — the street
    and house number only (the part before a comma or a postal code), folded for comparison."""
    s = (text or "").split(",")[0]
    m = _PLZ_TOWN.match(s.strip())
    if m:
        s = m.group("street")
    s = _fold(s).replace("ue", "u").replace("oe", "o").replace("ae", "a")
    s = re.sub(r"str\.?(?=\s|\d|$)", "strasse", s)
    return re.sub(r"[^a-z0-9]", "", s)


def has_house_number(text: str | None) -> bool:
    """True when the text reads as «Street 12[a]» — a street word and a house number."""
    s = (text or "").split(",")[0].strip()
    return bool(re.fullmatch(r"[^\d,]*[A-Za-zÀ-ÿ][^\d,]*\s\d{1,4}\s?[a-zA-Z]?", s))


def town_key(text: str | None) -> str:
    """«4104 Oberwil BL», «Oberwil (BL)», «Oberwil» → «oberwil»."""
    s = _CANTON_SUFFIX.sub("", (text or "").strip())
    s = re.sub(r"\b\d{4}\b", "", s)
    return re.sub(r"[^a-z]", "", _fold(s))


def town_of(locality: str | None) -> str | None:
    """«4106 Therwil» / «Oberwil BL» / «Oberwil (BL)» → the town as it is written («Therwil»)."""
    s = _CANTON_SUFFIX.sub("", re.sub(r"\b\d{4}\b", "", locality or "")).strip(" ,")
    return s or None


def split_label(label: str) -> tuple[str, str | None, str | None]:
    """A register label → (street + number, postal code, town). «Erlenstrasse 60 4106 Therwil» →
    («Erlenstrasse 60», «4106», «Therwil»); a label without a postal code stays whole."""
    first = label.split(",")[0].strip() if "," in label else label.strip()
    rest = label.split(",", 1)[1].strip() if "," in label else ""
    m = _PLZ_TOWN.match(f"{first} {rest}".strip() if rest else first)
    if not m:
        return first, None, None
    return m.group("street").strip(), m.group("plz"), town_of(m.group("town"))


@dataclass(frozen=True)
class Located:
    """An exact register match for an object's address."""

    label: str
    lat: float
    lng: float
    street: str
    town: str | None
    #: the home locality (``map.geocoder.defaultLocality``)
    home: bool


@dataclass(frozen=True)
class Location:
    """What `locate` found: ``hit`` when exactly one place is the address, else why not —
    ``none`` (no exact match in the area), ``ambiguous`` (several towns, none of them home; the
    station decides), ``unavailable`` (the geocoder could not be asked), ``not_an_address``."""

    hit: Located | None
    status: str
    candidates: tuple[Located, ...] = ()


def _in_bbox(attrs: dict, bbox: str) -> bool:
    try:
        w, s, e, n = (float(v) for v in bbox.split(","))
        x, y = float(attrs["y"]), float(attrs["x"])  # swisstopo: y = easting, x = northing
    except (KeyError, TypeError, ValueError):
        return True  # no usable bbox or no LV95 on the hit: the region pass already filtered
    return w <= x <= e and s <= y <= n


def is_home(town: str | None, plz: str | None, default_locality: str) -> bool:
    if not default_locality.strip():
        return False
    home_plz = _HAS_PLZ.search(default_locality)
    if plz and home_plz and plz == home_plz.group(0):
        return True
    return bool(town) and town_key(town) == town_key(default_locality)


async def locate(address: str) -> Location:
    """The ONE place an object's address names, or why there is none (see the block comment)."""
    if not has_house_number(address):
        return Location(None, "not_an_address")
    if not _GEOCODER_OK:
        return Location(None, "unavailable")
    default_locality, bbox = await _resolve_bias()
    want = street_key(address)
    _street, want_plz, want_town = split_label(address.replace(",", " "))
    try:
        results = await _upstream(address.strip(), bbox, 20)
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("locate failed for %r: %s", address, e)
        return Location(None, "unavailable")
    found: dict[str, Located] = {}
    for r in results:
        attrs = r.get("attrs", {})
        if attrs.get("origin", "address") != "address" or attrs.get("lat") is None or attrs.get("lon") is None:
            continue
        label = _TAGS.sub("", attrs.get("label") or "").strip()
        street, plz, town = split_label(label)
        if street_key(street) != want or (bbox and not _in_bbox(attrs, bbox)):
            continue
        if want_plz and plz and plz != want_plz:
            continue
        if want_town and town and not want_plz and town_key(town) != town_key(want_town):
            continue
        key = f"{plz}|{town_key(town)}"
        found.setdefault(
            key,
            Located(
                label=f"{street}, {plz} {town}" if plz and town else label,
                lat=float(attrs["lat"]),
                lng=float(attrs["lon"]),
                street=street,
                town=town,
                home=is_home(town, plz, default_locality),
            ),
        )
    hits = tuple(found.values())
    home = [h for h in hits if h.home]
    if home:
        return Location(home[0], "exact", hits)
    if len(hits) == 1:
        return Location(hits[0], "exact", hits)
    return Location(None, "ambiguous" if hits else "none", hits)


async def search_area(address: str, limit: int = 8) -> list[GeoHit]:
    """The address picker of «Lage korrigieren»: what the text names in the brigade's area, the
    exact street + number first and the home town first among them. Unlike `search`, the home
    locality is NOT appended — that is what turned «Erlenstrasse 60» into Oberwil's
    «Vorderbergstrasse 60». Then `search`'s own hits behind, for a half-typed street."""
    if not address or not address.strip() or not _GEOCODER_OK:
        return []
    default_locality, bbox = await _resolve_bias()
    try:
        results = await _upstream(address.strip(), bbox, max(limit, 10))
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("Area search failed for %r: %s", address, e)
        results = []
    want = street_key(address)
    hits = _parse(results)
    exact = [h for h in hits if street_key(h.label) == want]
    rest = [h for h in hits if street_key(h.label) != want]
    out = _home_first(exact, default_locality) + _home_first(rest, default_locality)
    seen = {h.label for h in out}
    out += [h for h in await search(address, limit=limit) if h.label not in seen]
    return out[:limit]


async def locate_coordinates(address: str) -> tuple[float, float] | None:
    """`locate` as a coordinate, for the unattended object paths (import, repair, SharePoint) —
    None unless exactly one place is the address."""
    loc = await locate(address)
    if loc.hit is None:
        if loc.status == "ambiguous":
            logger.warning(
                "object address %r is ambiguous in the area (%s) — left without a position for the station",
                address,
                "; ".join(h.label for h in loc.candidates),
            )
        return None
    return loc.hit.lat, loc.hit.lng
