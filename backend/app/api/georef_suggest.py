"""Automatic plan alignment — POST /api/georef/suggest.

The client sends the rendered plan bitmap (its own «Deckung prüfen» snapshot), the object
coordinate and the calibration-derived metres-per-pixel; the server segments the sheet,
fetches OSM building rings through the station's Overpass proxy and returns a similarity fit
as TWO reference pairs (`kind: "auto"`) plus its score. The client seeds «Deckung prüfen»
with them — the operator reviews, adjusts and only then accepts. Nothing is stored here.

The 200 answer is an NDJSON STREAM, so the busy card can show the real phases instead of one
opaque spinner over a 3–15 s wait: a `{"step": "osm"|"match"}` line as each phase begins, then
exactly one of `{"result": {…SuggestResponse}}` or `{"error": "<German sentence>"}` (an error
after the phases have begun cannot change the status line any more — it travels in-band).
Everything checkable BEFORE the stream begins still answers a plain HTTP error.

The heavy CV dependencies live in the optional `georef` group (`uv sync --extra georef`);
without them this endpoint answers 503 and the app falls back to «Punkte selbst setzen».
Editor-auth: a suggestion is a step in authoring a georeference, which is editor work.
"""

import json
import logging
import math
import time
from collections.abc import AsyncIterator

import anyio
from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import overpass as overpass_client
from ..auth.dependencies import CurrentEditor

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/georef", tags=["georef"])

# An A3 sheet at 150 dpi is ~2 MB as JPEG; anything past this is not a plan snapshot.
_MAX_UPLOAD = 8 * 1024 * 1024

# ⚠️ The DECODED size needs its own bound — the JPEG cap does not give one (8 MB decodes to
# far more), and the resize below multiplies it. A real client raster is ≤1755 px long side
# (< 2.2 MP); past this the request is not a plan snapshot, whatever it compressed to.
_MAX_DECODED_PX = 6_000_000
# …and the normalization must never be allowed to build a monster either: the resample target
# is capped so an adversarial (or simply wrong) mPerPx cannot turn one editor request into a
# multi-gigabyte allocation that OOM-kills the backend for everyone.
_MAX_RESIZED_SIDE = 6000

# The matcher is a 3–15 s CPU burn per request and a thread cannot be cancelled once started —
# its own small limiter keeps a burst of retries from pegging every core and starving the PDF
# renderers, which share the default thread pool.
_match_limiter = anyio.CapacityLimiter(2)


def _load_matcher():
    """The lazy heavy-deps import, as a SEAM: the 503-fail-closed path is exactly what holds on
    a production image without the `georef` extra, so it must be testable from an environment
    where the extra IS installed — the test monkeypatches this to raise."""
    from .. import georef_suggest

    return georef_suggest


# Overpass answers for one object change on OSM's timescale, not the operator's: cache them per
# rounded coordinate so a re-run after «Anpassen»/a retry does not re-ask the public mirrors
# (which rate-limit), and serve the last good answer when every mirror momentarily fails.
_OSM_TTL_S = 600
_osm_cache: dict[str, tuple[float, dict]] = {}


async def _osm_around(lng: float, lat: float, radius_m: float) -> dict:
    # the radius is part of the identity: a Modul-1 attempt needs the WIDE box, and must not be
    # handed the narrow one a Modul-2 attempt on the same object just cached
    key = f"{round(lng, 4)},{round(lat, 4)},{round(radius_m)}"
    now = time.monotonic()
    hit = _osm_cache.get(key)
    if hit and now - hit[0] < _OSM_TTL_S:
        return hit[1]
    dlat = radius_m / 111_320
    dlng = radius_m / (111_320 * math.cos(math.radians(lat)))
    bbox = f"{lat - dlat},{lng - dlng},{lat + dlat},{lng + dlng}"
    try:
        data = await overpass_client.fetch_buildings(overpass_client.BUILDINGS_QUERY.format(bbox=bbox))
    except Exception:
        # stale beats a 502 — buildings do not move. The entry may be well past the TTL (it
        # only ever leaves by LRU eviction), which is still the better answer than nothing.
        if hit:
            return hit[1]
        raise
    _osm_cache[key] = (now, data)
    if len(_osm_cache) > 64:
        del _osm_cache[min(_osm_cache, key=lambda k: _osm_cache[k][0])]
    return data


class _Pt(BaseModel):
    x: float
    y: float


class _LngLat(BaseModel):
    lng: float
    lat: float


class SuggestPair(BaseModel):
    plan: _Pt
    lngLat: _LngLat  # noqa: N815
    kind: str


class SuggestResponse(BaseModel):
    """`found: false` is a normal answer (segmentation found nothing, or the best fit scored
    past the ceiling) — the surface then offers the manual point flow, not an error toast.
    `confident: false` marks the band between cutoff and ceiling: a pose worth reviewing,
    surfaced with the «Deckung nachprüfen» warning instead of the plain proposal head."""

    found: bool
    confident: bool | None = None
    pairs: list[SuggestPair] = []
    rotationDeg: float | None = None  # noqa: N815
    score: float | None = None
    coverage: float | None = None
    seconds: float


@router.post("/suggest")
async def suggest_alignment(
    _user: CurrentEditor,
    image: UploadFile,
    lng: float,
    lat: float,
    mPerPx: float,  # noqa: N803 — camelCase mirrors the client wire format
    template: str = "m2",
) -> StreamingResponse:
    try:
        matcher = _load_matcher()
    except ImportError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Automatische Ausrichtung ist auf diesem Server nicht installiert",
        ) from exc

    # mPerPx tops out well under 0.5 for every real template (1:2500 @ 150 dpi = 0.42); the
    # bound is generous but keeps the resize factor — mPerPx / TUNED_M_PER_PX — small
    if not (-180 <= lng <= 180 and -90 <= lat <= 90) or not (0 < mPerPx < 1) or template not in ("m1", "m2"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "ungültige Parameter")
    if not overpass_client.mirrors():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Overpass ist nicht konfiguriert")

    raw = await image.read(_MAX_UPLOAD + 1)
    if len(raw) > _MAX_UPLOAD:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Bild zu gross")
    if not raw:
        # cv2.imdecode ASSERTS on an empty buffer instead of returning None — refuse it here
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Bild nicht lesbar")

    started = time.monotonic()

    def run(osm: dict) -> SuggestResponse:
        import cv2
        import numpy as np

        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Bild nicht lesbar")
        if img.shape[0] * img.shape[1] > _MAX_DECODED_PX:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Bild zu gross")
        # Normalize to what the segmentation kernels were tuned at. Sheets in the evaluated
        # ground-resolution band get the page-size rule (A4 @ 150 dpi ≈ 1755 px long side — a
        # phone's ~900 px bake would otherwise lose its grey fills to the 9×9 opening); a
        # COARSER sheet (Modul 1 at 1:2500 ≈ 0.42 m/px) is instead resampled toward the tuned
        # ground resolution, or a 10 m house stays smaller than the kernel however big the page.
        h, w = img.shape[:2]
        m_per_px = mPerPx
        factor = (m_per_px / matcher.TUNED_M_PER_PX) if m_per_px > 0.20 else 1755 / max(h, w)
        factor = min(factor, _MAX_RESIZED_SIDE / max(h, w))  # bounded, whatever mPerPx claimed
        if abs(factor - 1) > 0.05:
            img = cv2.resize(
                img,
                (max(1, round(w * factor)), max(1, round(h * factor))),
                interpolation=cv2.INTER_AREA if factor < 1 else cv2.INTER_CUBIC,
            )
            m_per_px = m_per_px / factor
        rings = matcher.rings_from_overpass(osm, lng, lat)
        seconds = lambda: round(time.monotonic() - started, 2)  # noqa: E731
        try:
            s = matcher.suggest(img, m_per_px, rings, template)
        except ValueError as exc:
            logger.info("georef suggest: no fit (%s)", exc)
            return SuggestResponse(found=False, seconds=seconds())
        ceiling = matcher.SCORE_CEILING_M1 if template == "m1" else matcher.SCORE_CEILING
        if s.score > ceiling:
            logger.info("georef suggest: rejected by score %.2f (template %s)", s.score, template)
            return SuggestResponse(found=False, score=round(s.score, 2), seconds=seconds())
        pairs = matcher.suggestion_pairs(s, img.shape[1], img.shape[0], lng, lat)
        return SuggestResponse(
            found=True,
            # M1 has no independently validated confidence threshold. A lower union score
            # fixes compound ranking; it must not silently promote this template's claim.
            confident=template != "m1" and s.score <= matcher.SCORE_CUTOFF,
            pairs=[SuggestPair(**p) for p in pairs],
            rotationDeg=round(s.rotation_deg, 2),
            score=round(s.score, 2),
            coverage=round(s.coverage, 3),
            seconds=seconds(),
        )

    # the OSM box scales with the sheet's printed ground extent (a 1:2500 Modul 1 covers far
    # more than the evaluated ±190 m); decoded lazily just for the dimensions is wasteful, so
    # approximate the long side from the upload — the client sends ≤1755 px rasters
    radius = matcher.reference_radius_m(mPerPx, 1755)

    async def stream() -> AsyncIterator[str]:
        yield json.dumps({"step": "osm"}) + "\n"
        try:
            osm = await _osm_around(lng, lat, radius)
        except Exception:  # noqa: BLE001 — headers are sent; ANY fetch failure must go in-band
            yield json.dumps({"error": "Overpass nicht erreichbar"}) + "\n"
            return
        yield json.dumps({"step": "match"}) + "\n"
        try:
            # CPU-bound for 3–15 s — off the event loop, and through the matcher's OWN limiter
            result = await anyio.to_thread.run_sync(run, osm, limiter=_match_limiter)
        except HTTPException as exc:
            yield json.dumps({"error": str(exc.detail)}) + "\n"
            return
        except Exception:
            logger.exception("georef suggest failed")
            yield json.dumps({"error": "Automatische Ausrichtung fehlgeschlagen"}) + "\n"
            return
        yield json.dumps({"result": result.model_dump()}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")
