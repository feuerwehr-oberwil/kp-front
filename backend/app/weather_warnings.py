"""Official warnings for a point on the Karte: MeteoSwiss (via MeteoAlarm) and Alertswiss.

Ported from kp-rueck (R5, feuerwehr-oberwil/kp-rueck#167, 08.10.2026), parsing and selection
unchanged. One difference in use: Rück filters for the station; KP Front filters for the
Einsatz the device is looking at (app/api/weather · layer takes the point), so the national
candidates are kept unfiltered and `select` runs per request.

MeteoSwiss does not publish its warnings as open data; it relays them, as CAP 1.2, through
MeteoAlarm (`sender` is `meteoalarm.cap@meteoswiss.ch`). MeteoSwiss's ordinance (MetO art. 5)
lets anyone pass a warning on only PROMPTLY and UNALTERED, and the feed's licence is CC BY 4.0
«with additional redistribution requirements». So nothing in here rewrites a word: headline,
description and instruction travel to the app exactly as the feed carries them, per
language, and the app shows them verbatim with the source beside them. What we do decide
is WHICH warnings are shown – those whose region polygon contains the Einsatz – and their
order.

Alertswiss (BABS) carries what MeteoSwiss does not – cantonal fire bans, drought measures,
closures. Its JSON is the public website's own, undocumented, with no stated licence or
stability promise. It is parsed defensively and is strictly best-effort: when its shape
changes, this source reports an error and the MeteoSwiss half keeps working.
"""

from __future__ import annotations

import html
import re
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from .geo_util import haversine_m, point_in_ring

#: MeteoAlarm awareness levels: 1 green (no warning; the feed uses it for «lifted» updates),
#: 2 yellow, 3 orange, 4 red. Only 2+ is a warning.
MIN_WARNING_LEVEL = 2

#: Alertswiss severities onto the same 1–4 scale, so both sources sort and colour alike.
ALERTSWISS_LEVELS = {"minor": 1, "moderate": 2, "severe": 3, "extreme": 4}

LANGUAGES = ("de", "fr", "it", "en")

Ring = list[tuple[float, float]]


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _cap_ring(text: str) -> Ring:
    """CAP polygon: «lat,lon lat,lon …»."""
    ring: Ring = []
    for pair in text.split():
        lat, _, lon = pair.partition(",")
        try:
            ring.append((float(lat), float(lon)))
        except ValueError:
            continue
    return ring


def _awareness(parameters: Iterable[dict[str, Any]], name: str) -> tuple[int | None, str | None]:
    """`"2; yellow; Moderate"` → (2, "yellow"); `"10; rain"` → (10, "rain")."""
    for parameter in parameters:
        if parameter.get("valueName") == name:
            parts = [p.strip() for p in str(parameter.get("value", "")).split(";")]
            try:
                number = int(parts[0])
            except (ValueError, IndexError):
                return None, None
            return number, parts[1] if len(parts) > 1 else None
    return None, None


def meteoalarm_candidates(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Every current MeteoSwiss warning in the national feed, normalised, polygons kept.

    Not yet filtered by place or time – that happens in `select` – so a different point
    coordinate can be re-filtered without fetching the 2 MB feed again.
    """
    out: list[dict[str, Any]] = []
    for entry in payload.get("warnings", []):
        alert = entry.get("alert") if isinstance(entry, dict) else None
        if not isinstance(alert, dict):
            continue
        if alert.get("status") != "Actual" or alert.get("msgType") == "Cancel":
            continue
        infos = [i for i in alert.get("info", []) if isinstance(i, dict)]
        if not infos:
            continue
        level, colour = _awareness(infos[0].get("parameter", []), "awareness_level")
        _, kind = _awareness(infos[0].get("parameter", []), "awareness_type")
        if level is None or level < MIN_WARNING_LEVEL:
            continue

        by_language = {str(i.get("language", "")).lower()[:2]: i for i in infos}
        primary = by_language.get("de") or infos[0]
        texts = {
            lang: {
                "event": info.get("event") or "",
                "headline": info.get("headline") or "",
                "description": info.get("description") or "",
                "instructions": [info["instruction"]] if info.get("instruction") else [],
            }
            for lang, info in by_language.items()
            if lang in LANGUAGES
        }
        # Areas are identical across the language blocks; keep each one's polygons and name.
        areas = []
        for area in primary.get("area", []):
            rings = [_cap_ring(p) for p in area.get("polygon", []) if isinstance(p, str)]
            rings = [r for r in rings if len(r) >= 3]
            if rings:
                areas.append({"name": area.get("areaDesc") or "", "rings": rings})
        if not areas:
            continue
        out.append(
            {
                "id": f"meteoalarm:{alert.get('identifier') or entry.get('uuid')}",
                "source": "meteoswiss",
                "level": min(level, 4),
                "color": colour,
                "kind": kind,
                "sent": _iso(_parse_time(alert.get("sent"))),
                "onset": _iso(_parse_time(primary.get("onset") or primary.get("effective"))),
                "expires": _iso(_parse_time(primary.get("expires"))),
                "sender": primary.get("senderName") or "MeteoSwiss",
                "link": primary.get("web") or None,
                "texts": texts,
                "areas": areas,
                "nationwide": False,
            }
        )
    return out


def _as_text(value: Any, key: str) -> str:
    """Alertswiss wraps most strings: `{"title": "…"}`. Accept the bare string too."""
    if isinstance(value, dict):
        value = value.get(key, "")
    return html.unescape(value) if isinstance(value, str) else ""


_REFERENCE_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T[\d:]+(?:[+-]\d{2}:\d{2}|Z)?")


def _alertswiss_sent(alert: dict[str, Any]) -> datetime | None:
    # `sent` is display text («Fr., 11.09.2026, 12:23»); `reference` ends in the ISO time.
    match = _REFERENCE_TIME.search(str(alert.get("reference", "")))
    return _parse_time(match.group(0)) if match else None


def _truthy(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() == "true")


def alertswiss_candidates(payloads: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Alertswiss alerts, normalised. `payloads` maps a language to that language's feed;
    the texts of one alert are joined across them by `identifier`."""
    merged: dict[str, dict[str, Any]] = {}
    for lang, payload in payloads.items():
        for alert in payload.get("alerts", []) if isinstance(payload, dict) else []:
            if not isinstance(alert, dict) or not alert.get("identifier"):
                continue
            if _truthy(alert.get("testAlert")) or _truthy(alert.get("technicalTestAlert")):
                continue
            if _truthy(alert.get("allClear")):
                continue
            identifier = str(alert["identifier"])
            instructions = [
                html.unescape(i["text"])
                for i in alert.get("instructions", []) or []
                if isinstance(i, dict) and isinstance(i.get("text"), str) and i["text"].strip()
            ]
            text = {
                "event": _as_text(alert.get("event"), "event"),
                "headline": _as_text(alert.get("title"), "title"),
                "description": _as_text(alert.get("description"), "description"),
                "instructions": instructions,
            }
            if identifier in merged:
                merged[identifier]["texts"][lang] = text
                continue
            areas = []
            for area in alert.get("areas", []) or []:
                if not isinstance(area, dict):
                    continue
                rings = []
                for polygon in area.get("polygons", []) or []:
                    ring: Ring = []
                    for point in (polygon or {}).get("coordinates", []) or []:
                        try:
                            ring.append((float(point[0]), float(point[1])))
                        except (TypeError, ValueError, IndexError):
                            continue
                    if len(ring) >= 3:
                        rings.append(ring)
                circles = [c for c in (_alertswiss_circle(c) for c in area.get("circles", []) or []) if c]
                if rings or circles:
                    areas.append(
                        {"name": _as_text(area.get("description"), "description"), "rings": rings, "circles": circles}
                    )
            links = [link for link in alert.get("links", []) or [] if isinstance(link, dict) and link.get("href")]
            merged[identifier] = {
                "id": f"alertswiss:{identifier}",
                "source": "alertswiss",
                "level": ALERTSWISS_LEVELS.get(str(alert.get("severity", "")).lower(), 1),
                "color": None,
                "kind": None,
                "sent": _iso(_alertswiss_sent(alert)),
                "onset": None,
                "expires": None,  # Alertswiss alerts hold «bis auf Widerruf» – until withdrawn
                "sender": alert.get("publisherName") or "Alertswiss",
                "link": links[0]["href"] if links else None,
                "texts": {lang: text},
                "areas": areas,
                "nationwide": _truthy(alert.get("nationWide")),
            }
    return list(merged.values())


def _alertswiss_circle(circle: Any) -> tuple[float, float, float] | None:
    """`{"centerPosition": ["46.76970", "8.67591"], "radius": "0.2666"}` → (lat, lon, metres).

    A local notice (a closed road, a blasting zone) often comes as a circle only. The radius is
    in KILOMETRES, as in the CAP 1.2 `<circle>` this feed is built from («lat,lon radius», km).
    """
    if not isinstance(circle, dict):
        return None
    try:
        lat, lon = (float(v) for v in circle["centerPosition"][:2])
        radius_km = float(circle["radius"])
    except (KeyError, TypeError, ValueError):
        return None
    if radius_km <= 0:
        return None
    return lat, lon, radius_km * 1000.0


def _covering_area(candidate: dict[str, Any], lat: float, lon: float) -> str | None:
    for area in candidate["areas"]:
        if any(point_in_ring(lat, lon, ring) for ring in area["rings"]):
            return str(area["name"])
        if any(haversine_m(lat, lon, c_lat, c_lon) <= radius for c_lat, c_lon, radius in area.get("circles", [])):
            return str(area["name"])
    return None


def select(
    candidates: Iterable[dict[str, Any]],
    lat: float,
    lon: float,
    now: datetime,
    in_switzerland: bool = True,
) -> list[dict[str, Any]]:
    """The warnings that apply at the point now or later, highest level first.

    The returned dicts carry `region` (the matched area's own name) instead of polygons.
    """
    out = []
    for candidate in candidates:
        expires = _parse_time(candidate.get("expires"))
        if expires is not None and expires <= now:
            continue
        region = _covering_area(candidate, lat, lon)
        if region is None and candidate.get("nationwide") and in_switzerland and not candidate["areas"]:
            region = ""
        if region is None:
            continue
        item = {k: v for k, v in candidate.items() if k not in ("areas", "nationwide")}
        item["region"] = region
        out.append(item)
    out.sort(key=lambda w: (-int(w["level"]), w.get("onset") or w.get("sent") or ""))
    return out
