"""Prepare an alignment from one immutable PDF page; never publish it implicitly."""

from __future__ import annotations

import hashlib
import io
import math
import re
import time
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import TypedDict

import anyio

from . import overpass, storage
from .api.georef_suggest import _load_matcher, _match_limiter, _osm_around
from .pdfium_lock import pdfium_lock

RENDER_SIDE = 1755
MAX_PAGES = 100
MATCHER_VERSION = "global-coverage-search-2026-09-12"


class Capability(TypedDict):
    available: bool
    reason: str | None


class ReferencePoint(TypedDict):
    lng: float
    lat: float


def alignment_capability() -> Capability:
    """Expose actual runtime capability without importing the CV stack at application boot."""
    try:
        _load_matcher()
    except (ImportError, OSError):
        return {"available": False, "reason": "georef_dependencies_missing"}
    if not overpass.mirrors():
        return {"available": False, "reason": "overpass_unconfigured"}
    return {"available": True, "reason": None}


@dataclass(frozen=True)
class RenderedPage:
    png: bytes
    width: int
    height: int
    aspect: float
    printed_scale: float | None
    page_count: int
    digest: str


def render_page(storage_key: str, page: int, expected_digest: str | None = None) -> RenderedPage:
    """Read exact stored bytes and hold PDFium's process lock through every object's closure.

    Called from a worker thread. The last printed 1:NNN on THIS page follows the existing
    planPrintedMPerU heuristic; scans without text require an explicit matching calibration.
    """
    import pypdfium2 as pdfium

    data = storage.get_bytes(storage_key)
    digest = hashlib.sha256(data).hexdigest()
    if expected_digest is not None and digest != expected_digest:
        raise ValueError("revision_digest_mismatch")
    with pdfium_lock:
        document = pdfium.PdfDocument(data)
        try:
            count = len(document)
            if not 0 <= page < count:
                raise ValueError("page_out_of_range")
            if count > MAX_PAGES:
                raise ValueError("too_many_pages")
            pdf_page = document[page]
            try:
                width_pt, height_pt = pdf_page.get_size()
                if not all(math.isfinite(n) and n > 0 for n in (width_pt, height_pt)):
                    raise ValueError("invalid_page_size")
                text_page = pdf_page.get_textpage()
                try:
                    text = text_page.get_text_range()
                finally:
                    text_page.close()
                scales = re.findall(r"1\s*:\s*(\d{3,5})\b", text)
                printed = int(scales[-1]) * height_pt / 72 * 0.0254 if scales else None
                bitmap = pdf_page.render(scale=RENDER_SIDE / max(width_pt, height_pt))
                try:
                    image = bitmap.to_pil()
                    try:
                        buf = io.BytesIO()
                        image.save(buf, format="PNG")
                        width, height = image.size
                    finally:
                        image.close()
                finally:
                    bitmap.close()
                return RenderedPage(buf.getvalue(), width, height, width_pt / height_pt, printed, count, digest)
            finally:
                pdf_page.close()
        finally:
            document.close()


def render_preview(storage_key: str, page: int = 0) -> bytes:
    """PNG preview helper; API callers must run it off the request event loop."""
    return render_page(storage_key, page).png


def calibrated_scale(raw: object, object_id: str, module: str, page: int, aspect: float) -> float | None:
    """Only the concrete object sheet's scale is eligible; never borrow a station default.

    Existing station calibrations identify the first page only. Later pages cannot inherit
    one: a multi-page module may mix scales. An aspect mismatch also invalidates the fallback.
    """
    if page != 0 or not isinstance(raw, dict):
        return None
    by_plan = raw.get("byPlan")
    if not isinstance(by_plan, dict):
        return None
    entry = by_plan.get(f"object:{object_id}:plan:{module}")
    if not isinstance(entry, dict):
        return None
    scale, ar = entry.get("mPerU"), entry.get("ar")
    if not isinstance(scale, (int, float)) or not isinstance(ar, (int, float)):
        return None
    if any(isinstance(x, bool) or not math.isfinite(x) or x <= 0 for x in (scale, ar)):
        return None
    if abs(ar / aspect - 1) > 0.01:
        return None
    return float(scale)


@dataclass(frozen=True)
class AlignmentResult:
    status: str
    reason: str | None = None
    pairs: list[dict] = field(default_factory=list)
    aspect: float | None = None
    scale_m_per_u: float | None = None
    score: float | None = None
    coverage: float | None = None
    reference_rings: list[list[ReferencePoint]] = field(default_factory=list)
    reference_source: str | None = None
    reference_at: datetime | None = None


async def compute_alignment(
    rendered: RenderedPage,
    module: str,
    lng: float | None,
    lat: float | None,
    fallback_scale: float | None,
) -> AlignmentResult:
    """Return honest review data, including the exact reference geometry used by the fit."""
    if rendered.page_count != 1:
        # The field viewer stitches a floor pack into ONE tall canvas. A fit measured on an
        # individual page would therefore be applied to different coordinates in the field.
        return AlignmentResult("unsupported", "multi_page_document", aspect=rendered.aspect)
    if module not in ("modul1", "modul2", "modul2-3"):
        return AlignmentResult("unsupported", "unsupported_module", aspect=rendered.aspect)
    if lng is None or lat is None or not (-180 <= lng <= 180 and -85 <= lat <= 85):
        return AlignmentResult("unavailable", "object_coordinates_missing", aspect=rendered.aspect)
    scale = rendered.printed_scale or fallback_scale
    scale_source = "printed PDF scale" if rendered.printed_scale else "exact sheet station calibration"
    if scale is None or not math.isfinite(scale) or not 0 < scale / rendered.height < 1:
        return AlignmentResult("unavailable", "printed_scale_missing", aspect=rendered.aspect)
    capability = await anyio.to_thread.run_sync(alignment_capability, limiter=_match_limiter)
    if not capability["available"]:
        return AlignmentResult("unavailable", capability["reason"], aspect=rendered.aspect, scale_m_per_u=scale)
    matcher = _load_matcher()
    radius = matcher.reference_radius_m(scale / rendered.height, max(rendered.width, rendered.height))
    # This is the observation time. The shared helper may serve cached OSM data; its timestamp
    # is deliberately not presented as the time OSM itself was edited or measured.
    reference_at = datetime.now(UTC)
    try:
        osm = await _osm_around(lng, lat, radius)
    except Exception:  # noqa: BLE001 – transport failures are reviewable job results
        return AlignmentResult("failed", "reference_unreachable", aspect=rendered.aspect, scale_m_per_u=scale)

    def match() -> AlignmentResult:
        import cv2
        import numpy as np

        image = cv2.imdecode(np.frombuffer(rendered.png, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("rendered_image_unreadable")
        m_per_px = scale / rendered.height
        factor = m_per_px / matcher.TUNED_M_PER_PX if m_per_px > 0.20 else RENDER_SIDE / max(image.shape[:2])
        factor = min(factor, 6000 / max(image.shape[:2]))
        if abs(factor - 1) > 0.05:
            image = cv2.resize(
                image,
                (round(image.shape[1] * factor), round(image.shape[0] * factor)),
                interpolation=cv2.INTER_AREA if factor < 1 else cv2.INTER_CUBIC,
            )
            m_per_px /= factor
        rings = matcher.rings_from_overpass(osm, lng, lat)
        reference_rings: list[list[ReferencePoint]] = []
        for ring in rings:
            points: list[ReferencePoint] = []
            for x, y in ring:
                point_lng, point_lat = matcher.local_to_wgs84(float(x), float(y), lng, lat)
                points.append({"lng": point_lng, "lat": point_lat})
            reference_rings.append(points)
        common = AlignmentResult(
            "no_match",
            aspect=rendered.aspect,
            scale_m_per_u=scale,
            reference_rings=reference_rings,
            reference_source=f"OSM / Overpass (cached allowed); {scale_source}; {MATCHER_VERSION}",
            reference_at=reference_at,
        )
        template = "m1" if module == "modul1" else "m2"
        started = time.monotonic()
        try:
            suggestion = matcher.suggest(image, m_per_px, rings, template)
        except ValueError:
            return replace(common, reason="no_matching_geometry")
        if not all(math.isfinite(x) for x in (suggestion.score, suggestion.coverage, suggestion.rotation_deg)):
            return replace(common, reason="invalid_match")
        if suggestion.coverage < matcher.COVERAGE_FLOOR:
            return replace(common, reason="low_coverage", score=suggestion.score, coverage=suggestion.coverage)
        pairs = matcher.suggestion_pairs(suggestion, image.shape[1], image.shape[0], lng, lat)
        if len(pairs) != 2 or any(p.get("kind") != "auto" for p in pairs):
            raise ValueError("invalid_matcher_pairs")
        # Context coverage is the one measured acceptance signal (georef_suggest.COVERAGE_CONFIDENT);
        # both templates share it. Neither state is publication: both still need an
        # administrator's explicit review and approval.
        status = "ready" if suggestion.coverage >= matcher.COVERAGE_CONFIDENT else "needs_review"
        return replace(
            common,
            status=status,
            pairs=pairs,
            score=suggestion.score,
            coverage=suggestion.coverage,
            reference_source=f"{common.reference_source}; match {time.monotonic() - started:.2f}s",
        )

    return await anyio.to_thread.run_sync(match, limiter=_match_limiter)
