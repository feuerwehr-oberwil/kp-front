"""Gebäude-Steckbrief — what the federal registers say about the building at an Einsatzort.

Two public, keyless sources on the same geo.admin host the geocoder already uses (SSRF-pinned
the same way, see geocode.py):

* **GWR** (eidg. Gebäude- und Wohnungsregister, layer ``ch.bfs.gebaeude_wohnungs_register``):
  identify at the incident point → the building's EGID plus its attributes – Gebäudeklasse,
  Geschosse, Wohnungen (and per Stockwerk, with their Zimmer), Baujahr/-periode, heating and
  hot-water generator + energy source, Zivilschutzraum.
* **BFE** (Elektrizitätsproduktionsanlagen, ``ch.bfe.elektrizitaetsproduktionsanlagen``): every
  registered plant carries the building's EGID, so «PV on this roof» is an exact join, not a
  distance guess.

⚠️ These are REGISTER HINTS, never facts about the building as it stands tonight. The heating
entry can be years old (``gwaerdath1``), and only plants registered with Pronovo are in the BFE
list — «no PV in the register» is not «no PV». So every fact travels with its source and date,
and the card says «Register-Hinweis».

Each source fails on its own: a GWR outage still lets the Objekt's Sofortmassnahmen through, a
BFE outage still shows the GWR facts. The answer is cached in-process per point (a day for a
clean answer, two minutes when a source failed, so a blip heals by itself); the device keeps
its own copy per Einsatz for offline (src/lib/api/building.ts).

The code lists follow the GWR Merkmalskatalog (4.3, current on housing-stat.ch on 20.10.2026),
cross-checked against the register's decoded popup (``…/<egid>_0/extendedHtmlPopup?lang=de``)
on 08.10.2026 (energy, period, status) and on 20.10.2026 (Gebäudeklasse, Wärmeerzeuger,
Stockwerk – one live building per code). They are mapped to stable KEYS here (``gas``, ``oil``,
…), and the words for those keys live in the app's copy, in all four locales.
"""

import asyncio
import logging
import math
import re
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

import httpx

from . import geocode
from .geo_util import haversine_m

logger = logging.getLogger(__name__)

GWR_LAYER = "ch.bfs.gebaeude_wohnungs_register"
PV_LAYER = "ch.bfe.elektrizitaetsproduktionsanlagen"

#: Switzerland's WGS84 bounding box (generous by a few hundred metres). Outside it the federal
#: registers have nothing to say, so we do not ask them.
_CH_BBOX = (5.94, 45.81, 10.50, 47.82)  # lng_min, lat_min, lng_max, lat_max

#: How far from the Einsatzort a register entry may sit and still be «the building». The GWR
#: point is the building's entrance coordinate, which is what the intake geocoder hands out too,
#: so a hit is usually within metres; 60 m covers a map-click on a large roof.
MAX_DISTANCE_M = 60.0

_OK_TTL_S = 24 * 3600.0
_ERROR_TTL_S = 120.0
_TIMEOUT_S = 8.0

# --- code lists ------------------------------------------------------------------------------

#: genh1/genh2 (heating) and genw1/genw2 (hot water): energy source → key.
ENERGY: dict[int, str] = {
    7500: "none",
    7501: "air",
    7510: "geothermal",
    7511: "geothermal",
    7512: "geothermal",
    7513: "water",
    7520: "gas",
    7530: "oil",
    7540: "wood",
    7541: "wood",
    7542: "wood",
    7543: "wood",
    7550: "waste_heat",
    7560: "electricity",
    7570: "solar",
    7580: "district",
    7581: "district",
    7582: "district",
    7598: "unknown",
    7599: "other",
}

#: Energy keys that put fuel ON SITE worth an immediate measure: the gas main valve, the oil tank.
HAZARD_ENERGY = frozenset({"gas", "oil"})

#: gbaup — the construction period when the exact year is unknown.
PERIOD: dict[int, tuple[int | None, int | None]] = {
    8011: (None, 1918),
    8012: (1919, 1945),
    8013: (1946, 1960),
    8014: (1961, 1970),
    8015: (1971, 1980),
    8016: (1981, 1985),
    8017: (1986, 1990),
    8018: (1991, 1995),
    8019: (1996, 2000),
    8020: (2001, 2005),
    8021: (2006, 2010),
    8022: (2011, 2015),
    8023: (2016, None),
}

#: gstat — only the states that change how the building is read; 1004 «bestehend» says nothing.
STATUS: dict[int, str] = {
    1001: "planned",
    1002: "approved",
    1003: "under_construction",
    1005: "unusable",
    1007: "demolished",
    1008: "not_built",
}


#: gklas – the Gebäudeklasse (Eurostat CC), grouped into what a crew reads off it. Codes that
#: say nothing (1274 «sonstige Hochbauten») or are newer than this table → no chip.
BUILDING_CLASS: dict[int, str] = {
    1110: "single_family",
    1121: "two_family",
    1122: "multi_family",
    1130: "home",  # Wohngebäude für Gemeinschaften: Alters-, Pflege-, Studentenheime
    1211: "hotel",
    1212: "hotel",  # andere kurzfristige Beherbergung
    1220: "office",
    1230: "retail",
    1231: "restaurant",
    1241: "transport",  # Bahnhof, Verkehr und Nachrichten, ohne Garagen
    1242: "garage",
    1251: "industry",
    1252: "storage",  # Behälter, Silos, Lager
    1261: "culture",
    1262: "culture",  # Museen, Bibliotheken
    1263: "school",
    1264: "hospital",
    1265: "sports_hall",
    1271: "farm",
    1272: "church",
    1273: "monument",
    1275: "collective",  # andere kollektive Unterkunft
    1276: "farm",  # Tierhaltung
    1277: "farm",  # Pflanzenbau
    1278: "farm",
}

#: gwaerzh1/2 (heating) and gwaerzw1/2 (hot water): the heat generator → (key, serves several
#: buildings). «für mehrere Gebäude» matters at night: the boiler may stand next door.
#: 7400/7600 «kein Wärmeerzeuger» and 7499/7699 «andere» are absent – they name nothing.
GENERATOR: dict[int, tuple[str, bool]] = {
    7410: ("heat_pump", False),
    7411: ("heat_pump", True),
    7420: ("solar_thermal", False),
    7421: ("solar_thermal", True),
    7430: ("boiler", False),
    7431: ("boiler", True),
    7432: ("boiler", False),
    7433: ("boiler", True),
    7434: ("boiler", False),
    7435: ("boiler", True),
    7436: ("stove", False),
    7440: ("chp", False),
    7441: ("chp", True),
    7450: ("electric_storage", False),
    7451: ("electric_storage", True),
    7452: ("electric_direct", False),
    7460: ("heat_exchanger", False),
    7461: ("heat_exchanger", True),
    7610: ("heat_pump", False),
    7620: ("solar_thermal", False),
    7630: ("boiler", False),
    7632: ("boiler", False),
    7634: ("boiler", False),
    7640: ("chp", False),
    7650: ("electric_boiler", False),  # zentraler Elektroboiler
    7651: ("electric_boiler", False),  # Kleinboiler
    7660: ("heat_exchanger", False),
}

#: wstat of a flat that stands today; projected, demolished … flats are not anybody's door.
FLAT_EXISTING = 3004


def floor_level(code: Any) -> int | None:
    """wstwk → a storey number: 3100 Parterre → 0, 3101 «1. Stock» → 1, 3401 «1. UG» → -1."""
    n = _int(code)
    if n is None:
        return None
    if 3100 <= n <= 3199:
        return n - 3100
    if 3401 <= n <= 3419:
        return -(n - 3400)
    return None


def energy_key(code: Any) -> str | None:
    """The key for a GWR energy code; None for «nothing» (no code, 7500 keine)."""
    try:
        key = ENERGY.get(int(code))
    except (TypeError, ValueError):
        return None
    if key is None:
        return "other"  # a code newer than this table is still SOMETHING, never silently nothing
    return None if key == "none" else key


def period_label(code: Any) -> str | None:
    """«1919–1945», «≤1918», «≥2016» — the construction period as printed on the card."""
    try:
        lo, hi = PERIOD[int(code)]
    except (TypeError, ValueError, KeyError):
        return None
    if lo is None:
        return f"≤{hi}"
    if hi is None:
        return f"≥{lo}"
    return f"{lo}–{hi}"


def parse_ch_date(value: Any) -> date | None:
    """«29.06.2022» (the register's date format) or an ISO string → a date; None otherwise."""
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text[:10], fmt).date()
        except ValueError:
            continue
    return None


def _int(value: Any) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n


def _keys(*codes: Any) -> list[str]:
    """Distinct energy keys of a building's first and second generator, in that order."""
    out: list[str] = []
    for c in codes:
        k = energy_key(c)
        if k and k not in out:
            out.append(k)
    return out


def _systems(pairs: list[tuple[Any, Any]]) -> list[dict[str, Any]]:
    """(generator code, energy code) per system → [{generator, energy, shared}], each distinct
    pair once, a system that names neither («kein Wärmeerzeuger» / «keine») dropped."""
    out: list[dict[str, Any]] = []
    for gen_code, energy_code in pairs:
        gen = GENERATOR.get(_int(gen_code) or 0)
        entry = {
            "generator": gen[0] if gen else None,
            "energy": energy_key(energy_code),
            "shared": bool(gen and gen[1]),
        }
        if (entry["generator"] or entry["energy"]) and entry not in out:
            out.append(entry)
    return out


def _flats(attrs: dict[str, Any]) -> tuple[list[dict[str, int]], int | None, int | None]:
    """The flat arrays (one entry per flat) → existing flats per storey + the Zimmer range.

    Per storey only when EVERY existing flat names its storey – half a picture of where people
    sleep reads like the whole one. A Maisonette is counted on its entrance storey (wstwk).
    """
    floors, states = attrs.get("wstwk"), attrs.get("wstat")
    if not isinstance(floors, list) or not isinstance(states, list) or len(floors) != len(states):
        return [], None, None
    duplex, rooms = attrs.get("wmehrg"), attrs.get("wazim")
    by_level: dict[int, dict[str, int]] = {}
    room_counts: list[int] = []
    complete = True
    for i, (code, state) in enumerate(zip(floors, states, strict=True)):
        if _int(state) != FLAT_EXISTING:
            continue
        if isinstance(rooms, list) and i < len(rooms) and (r := _int(rooms[i])) and r > 0:
            room_counts.append(r)
        level = floor_level(code)
        if level is None:
            complete = False
            continue
        row = by_level.setdefault(level, {"level": level, "flats": 0, "maisonettes": 0})
        row["flats"] += 1
        if isinstance(duplex, list) and i < len(duplex) and _int(duplex[i]) == 1:
            row["maisonettes"] += 1
    rows = [by_level[k] for k in sorted(by_level)] if complete else []
    return rows, min(room_counts, default=None), max(room_counts, default=None)


def decode_gwr(attrs: dict[str, Any]) -> dict[str, Any]:
    """GWR feature attributes → the card's facts (keys, numbers, dates; no words).

    Only what a crew acts on: what kind of building (a Heim, a school), Geschosse (ladder,
    Atemschutz), Wohnungen and on which storey (how many parties to warn, where), Baujahr (old
    timber, asbestos), what burns in the cellar and in what, and a Schutzraum.
    """
    floors = _int(attrs.get("gastw"))
    flats = _int(attrs.get("ganzwhg"))
    year = _int(attrs.get("gbauj"))
    shelter = _int(attrs.get("gschutzr"))
    status = STATUS.get(_int(attrs.get("gstat")) or 0)
    by_floor, rooms_min, rooms_max = _flats(attrs)
    return {
        "egid": str(attrs.get("egid")) if attrs.get("egid") not in (None, "") else None,
        "stand": parse_ch_date(attrs.get("gexpdat")),
        "floors": floors if floors and floors > 0 else None,
        "flats": flats if flats and flats > 0 else None,
        "year": year if year and year > 1000 else None,
        "period": None if year and year > 1000 else period_label(attrs.get("gbaup")),
        "heating": _keys(attrs.get("genh1"), attrs.get("genh2")),
        "heating_date": parse_ch_date(attrs.get("gwaerdath1")),
        "hot_water": _keys(attrs.get("genw1"), attrs.get("genw2")),
        "shelter": True if shelter == 1 else None,
        "status": status,
        "building_class": BUILDING_CLASS.get(_int(attrs.get("gklas")) or 0),
        "heaters": _systems([(attrs.get("gwaerzh1"), attrs.get("genh1")), (attrs.get("gwaerzh2"), attrs.get("genh2"))]),
        "water_heaters": _systems(
            [(attrs.get("gwaerzw1"), attrs.get("genw1")), (attrs.get("gwaerzw2"), attrs.get("genw2"))]
        ),
        "flats_by_floor": by_floor,
        "rooms_min": rooms_min,
        "rooms_max": rooms_max,
    }


_POWER = re.compile(r"(\d+(?:[.,]\d+)?)\s*(kW|MW|W)\b", re.IGNORECASE)


def parse_power_kw(value: Any) -> float | None:
    """«35.64 kW» → 35.64; «1.2 MW» → 1200.0. None when it does not read as a power."""
    m = _POWER.search(str(value or ""))
    if not m:
        return None
    n = float(m.group(1).replace(",", "."))
    unit = m.group(2).lower()
    return round(n * 1000 if unit == "mw" else n / 1000 if unit == "w" else n, 2)


def decode_plant(attrs: dict[str, Any], lang: str) -> dict[str, Any]:
    """One BFE plant → kind key + power + since + the register's own label in ``lang``."""
    sub_en = str(attrs.get("sub_category_en") or "").strip().lower()
    sub_de = str(attrs.get("sub_category_de") or "").strip().lower()
    kind = "pv" if sub_en.startswith("photovolt") or sub_de.startswith("photovolt") else "other"
    lbl = attrs.get(f"sub_category_{lang}") or attrs.get("sub_category_de") or None
    return {
        "kind": kind,
        "label": str(lbl).strip() if lbl else None,
        "power_kw": parse_power_kw(attrs.get("total_power")),
        "since": parse_ch_date(attrs.get("beginning_of_operation")),
    }


def clean_measures(text: str | None) -> str | None:
    """Sofortmassnahmen as stored: one measure per line, no blank lines, trimmed; None if empty."""
    if text is None:
        return None
    lines = [" ".join(line.split()) for line in str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    out = "\n".join(line for line in lines if line)
    return out or None


def in_switzerland(lat: float, lng: float) -> bool:
    lng_min, lat_min, lng_max, lat_max = _CH_BBOX
    return lng_min <= lng <= lng_max and lat_min <= lat <= lat_max


def _norm_addr(s: str | None) -> str:
    folded = unicodedata.normalize("NFKD", (s or "").lower())
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", folded)


def _street_of(address: str | None) -> str:
    """«Hauptstrasse 10, 4104 Oberwil» → normalised «hauptstrasse10» (the part before a comma)."""
    return _norm_addr((address or "").split(",")[0])


def pick_building(features: list[dict[str, Any]], lat: float, lng: float, address: str | None) -> dict | None:
    """The register entry that IS the Einsatzort's building, or None.

    identify answers in no particular order (on 08.10.2026 «Hauptstrasse 10» came third of four
    for a point on its own door). So: among the entries within MAX_DISTANCE_M, one whose street +
    number equals the incident's wins; otherwise the nearest. An entry without a usable point is
    never picked — «somewhere» is not «here».
    """
    street = _street_of(address)
    best: tuple[float, dict] | None = None
    for f in features:
        attrs = f.get("properties") or f.get("attributes") or {}
        if not attrs.get("egid"):
            continue
        coords = ((f.get("geometry") or {}).get("coordinates")) or []
        if len(coords) < 2 or not all(isinstance(c, (int, float)) for c in coords[:2]):
            continue
        dist = haversine_m(lat, lng, float(coords[1]), float(coords[0]))
        if dist > MAX_DISTANCE_M:
            continue
        if street and _norm_addr(attrs.get("strname_deinr")) == street:
            return attrs
        if best is None or dist < best[0]:
            best = (dist, attrs)
    return best[1] if best else None


# --- upstream --------------------------------------------------------------------------------


@dataclass
class RegisterAnswer:
    """What the two registers said about one point. ``gwr_ok``/``pv_ok`` False = that source
    could not be asked (timeout, 5xx, bad JSON); an empty answer from a source that WAS asked
    is ok with nothing in it.

    Language-free on purpose — the plants are kept as the register's raw attributes (which carry
    the label in all four languages) and decoded per request (:meth:`plants`), so one cached
    answer serves a German and a French station alike.
    """

    egid: str | None = None
    address: str | None = None
    gwr: dict[str, Any] | None = None
    gwr_ok: bool = True
    plant_attrs: list[dict[str, Any]] = field(default_factory=list)
    pv_ok: bool = True
    pv_asked: bool = False
    fetched_at: datetime = field(default_factory=lambda: datetime.now().astimezone())

    def plants(self, lang: str = "de") -> list[dict[str, Any]]:
        return [decode_plant(a, lang) for a in self.plant_attrs]


def _base() -> str | None:
    if not geocode._GEOCODER_OK:  # same SSRF pin as the geocoder: https + its own host only
        return None
    return geocode._IDENTIFY_URL.rsplit("/identify", 1)[0]


#: identify's search radius is in PIXELS of a pretend map image (mapExtent over imageDisplay).
#: A small image over a ±0.0015° window makes a pixel 2–4 m, so the tolerance below reaches
#: MAX_DISTANCE_M in every direction (east–west is the short side: a degree of longitude is
#: cos(lat) of a degree of latitude) — with the 500 px image it used to, 40 px was only ~18–27 m.
_IDENTIFY_HALF_DEG = 0.0015
_IDENTIFY_PX = 100
#: identify answers in NO particular order and cuts at `limit`, so the limit must hold every
#: entry inside the radius — in Oberwil's centre (09.10.2026) the 30 px radius returned 43, and a
#: limit of 30 dropped the building the point stood on in favour of its neighbour 11 m away.
_IDENTIFY_LIMIT = 200


def identify_tolerance_px(lat: float) -> int:
    """Pixels that cover MAX_DISTANCE_M east–west at this latitude (+10 % margin)."""
    m_per_px = (2 * _IDENTIFY_HALF_DEG / _IDENTIFY_PX) * 111_320.0 * math.cos(math.radians(lat))
    return math.ceil(MAX_DISTANCE_M * 1.1 / m_per_px)


async def _identify(client: httpx.AsyncClient, base: str, lat: float, lng: float) -> list[dict]:
    d = _IDENTIFY_HALF_DEG
    params = {
        "geometry": f"{lng},{lat}",
        "geometryType": "esriGeometryPoint",
        "geometryFormat": "geojson",
        "sr": "4326",
        "tolerance": str(identify_tolerance_px(lat)),
        "mapExtent": f"{lng - d},{lat - d},{lng + d},{lat + d}",
        "imageDisplay": f"{_IDENTIFY_PX},{_IDENTIFY_PX},96",
        "layers": f"all:{GWR_LAYER}",
        "returnGeometry": "true",
        "lang": "de",
        "limit": str(_IDENTIFY_LIMIT),
    }
    r = await client.get(f"{base}/identify", params=params)
    r.raise_for_status()
    return list(r.json().get("results", []))


async def _plant_attrs(client: httpx.AsyncClient, base: str, egid: str) -> list[dict]:
    params = {
        "layer": PV_LAYER,
        "searchField": "egid",
        "searchText": egid,
        "contains": "false",
        "returnGeometry": "false",
    }
    r = await client.get(f"{base}/find", params=params)
    r.raise_for_status()
    out = []
    for f in r.json().get("results", []):
        attrs = f.get("attributes") or f.get("properties") or {}
        # `find` with contains=false is exact, but a register that ever returns a near-miss must
        # not put somebody else's roof on this card
        if str(attrs.get("egid")) == egid:
            out.append(attrs)
    return out


async def ask_registers(lat: float, lng: float, address: str | None) -> RegisterAnswer:
    """Ask GWR then BFE about the building at (lat, lng). Never raises."""
    ans = RegisterAnswer()
    base = _base()
    if base is None:
        ans.gwr_ok = False
        return ans
    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        try:
            features = await _identify(client, base, lat, lng)
            attrs = pick_building(features, lat, lng, address)
        except (httpx.HTTPError, ValueError, TypeError, KeyError) as e:
            logger.warning("GWR identify failed for %s,%s: %s", lat, lng, e)
            ans.gwr_ok = False
            return ans
        if attrs is None:
            return ans
        ans.gwr = decode_gwr(attrs)
        ans.egid = ans.gwr["egid"]
        ans.address = geocode._label_from_gwr(attrs)
        if ans.egid:
            ans.pv_asked = True
            try:
                ans.plant_attrs = await _plant_attrs(client, base, ans.egid)
            except (httpx.HTTPError, ValueError, TypeError, KeyError) as e:
                logger.warning("BFE plant lookup failed for EGID %s: %s", ans.egid, e)
                ans.pv_ok = False
    return ans


_cache: dict[tuple, tuple[float, RegisterAnswer]] = {}
#: lookups in flight, per key — three devices opening one Einsatz at once ask the registers ONCE
_inflight: dict[tuple, asyncio.Future[RegisterAnswer]] = {}
_CACHE_MAX = 512


def _key(lat: float, lng: float, address: str | None) -> tuple:
    return (round(lat, 5), round(lng, 5), _street_of(address))


async def registers_cached(lat: float, lng: float, address: str | None) -> RegisterAnswer:
    """`ask_registers`, cached per point + street (a day; two minutes after a failure).

    Concurrent callers for the same key share one lookup. Single event loop, no await between the
    check and the registration, so no lock is needed for that.
    """
    key = _key(lat, lng, address)
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    pending = _inflight.get(key)
    if pending is not None:
        return await asyncio.shield(pending)
    fut: asyncio.Future[RegisterAnswer] = asyncio.get_running_loop().create_future()
    _inflight[key] = fut
    try:
        ans = await ask_registers(lat, lng, address)
    except BaseException as e:  # ask_registers never raises, but a cancellation still must not strand waiters
        _inflight.pop(key, None)
        if not fut.done():
            fut.set_exception(e)
            fut.exception()  # mark retrieved — a waiter-less failure must not warn at GC
        raise
    ttl = _OK_TTL_S if ans.gwr_ok and ans.pv_ok else _ERROR_TTL_S
    if len(_cache) >= _CACHE_MAX:
        for k in [k for k, (exp, _) in _cache.items() if exp <= now] or list(_cache)[: _CACHE_MAX // 4]:
            _cache.pop(k, None)
    _cache[key] = (time.monotonic() + ttl, ans)
    _inflight.pop(key, None)
    fut.set_result(ans)
    return ans


def clear_cache() -> None:
    _cache.clear()
    _inflight.clear()
