"""Automatic plan alignment — the CV matcher behind POST /api/georef/suggest.

Based on the feasibility prototype (docs/planning/auto-alignment/prototype.py,
2026-09-08: 12/16 Modul-2 sheets produced plausible starting alignments): segment the filled
building footprints out of the rendered sheet, fetch OSM building rings around the object,
and register the printed context onto them with seeded, fixed-scale trimmed ICP. A sparse
search followed by full-boundary refinement avoids both premature convergence and doing
the expensive refinement for every seed. Modul 1 scores its red compound against the full
building set, since an operational compound need not be a single OSM footprint. The result
is a similarity transform — a STARTING PROPOSAL the operator reviews in «Deckung prüfen»,
never a silently accepted georeference, and not a claim of survey accuracy.

This module carries the heavy numeric dependencies (opencv-python-headless, numpy, scipy —
the optional `georef` dependency group). The API seam (app/api/georef_suggest.py) imports it
lazily and answers 503 while they are not installed, so the base image owes nothing to it.

Frame conventions, kept from the prototype so its evaluation stays valid:
- Sheet pixels are y-DOWN; every boundary point is y-flipped into y-UP before fitting, so it
  shares the orientation of east/north metres.
- Reference metres are a local equirectangular frame anchored at the object coordinate
  (adequate over the ±190 m reference box; the client's own Mercator fit re-derives its
  transform from the returned pairs anyway, so no frame mismatch can accumulate).
- The printed scale is FIXED during ICP (`m_per_px` from the station calibration): a
  geometrically convenient fit that contradicts the printed scale is not a plausible one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np
from scipy.spatial import cKDTree

# Half-width of the OSM reference box around the object coordinate, in metres — the floor;
# `reference_radius_m` scales it up for sheets whose printed extent outruns it (Modul 1 at
# 1:2500 covers ~±370 m, and context with no reference to land on reads as pure error).
RADIUS_M = 190
RADIUS_MAX_M = 650

# The ground resolution the segmentation kernels are tuned at. The evaluated Modul-2 sheets
# rendered to 0.127–0.169 m/px and are left untouched (the page-size normalization below covers
# them); anything coarser — 1:2500 at 0.42 m/px shrinks a house below the 9×9 opening — is
# resampled toward this before segmenting.
TUNED_M_PER_PX = 0.15

# Combined ICP score below which a fit counts as CONFIDENT: in the evaluation every visually
# plausible fit stayed under it. Inherited from the experiment — a cutoff, not a probability.
SCORE_CUTOFF = 6.0

# …and the ceiling above which a fit is not offered at all. Between the two the pose is shown
# as an UNCERTAIN proposal («Deckung nachprüfen»): measured 08.09.2026 on Im Wasen 3a, a dense
# row-house sheet whose nearly-right pose scored 8.86 purely from OSM/cadastral footprint
# disagreement — withholding it left the operator with nothing, while the review surface shows
# exactly how right it is. The unambiguous garbage poses scored 17–55.
SCORE_CEILING = 12.0
# The Modul-1 template scores structurally higher even when the pose is near (photo inset and
# side panels contaminate the grey context; the wide extent multiplies footprint differences):
# The API keeps every M1 fit in the uncertain band, including low scores after compound
# matching: this template has no independently validated confidence threshold.
SCORE_CEILING_M1 = 16.0


def reference_radius_m(m_per_px: float, long_side_px: int) -> float:
    """The OSM box half-width for a sheet: ~55 % of its printed ground extent, floored at the
    evaluated 190 m and capped to keep the Overpass answer bounded."""
    return min(RADIUS_MAX_M, max(RADIUS_M, 0.55 * m_per_px * long_side_px))


# Inset of the two synthetic reference points from the sheet edge (normalized units). Diagonal
# corners maximize the plan-side spread the two-pair fit hangs on.
PAIR_INSET = 0.15


@dataclass(frozen=True)
class Suggestion:
    """One fitted similarity: y-up sheet px → local metres (`a`, `t`), plus its quality."""

    a: np.ndarray  # 2×2, rotation·scale
    t: np.ndarray  # 2, translation (local metres)
    score: float
    coverage: float  # fraction of context edges within 2.4 m of an OSM edge — not accuracy
    rotation_deg: float


def local_metres(lng: float, lat: float, anchor_lng: float, anchor_lat: float) -> tuple[float, float]:
    """WGS84 → the local equirectangular east/north frame anchored at the object."""
    return (
        (lng - anchor_lng) * 111_320 * math.cos(math.radians(anchor_lat)),
        (lat - anchor_lat) * 111_320,
    )


def local_to_wgs84(x: float, y: float, anchor_lng: float, anchor_lat: float) -> tuple[float, float]:
    """The exact inverse of `local_metres` — (lng, lat)."""
    return (
        anchor_lng + x / (111_320 * math.cos(math.radians(anchor_lat))),
        anchor_lat + y / 111_320,
    )


def rings_from_overpass(data: dict, anchor_lng: float, anchor_lat: float) -> list[np.ndarray]:
    """Building rings (local metres, ≥3 points) out of an Overpass `out geom` answer.

    Simple building ways are taken as-is; building relations have their outer way members
    stitched end-to-end by coordinate equality (Overpass repeats the shared node's coordinates
    verbatim, so float equality is the node identity). Open leftovers are kept when long
    enough — the sampler treats every ring as closed, and a mostly-complete outline still
    carries edges worth matching. Courtyard holes are ignored, as in the prototype.
    """
    rings: list[np.ndarray] = []

    def ring_of(coords: list[tuple[float, float]]) -> None:
        if len(coords) < 3:
            return
        rings.append(
            np.array(
                [local_metres(lng, lat, anchor_lng, anchor_lat) for lng, lat in coords],
                dtype=np.float64,
            )
        )

    for el in data.get("elements", []):
        if el.get("type") == "way" and "geometry" in el:
            ring_of([(g["lon"], g["lat"]) for g in el["geometry"] if "lon" in g and "lat" in g])
        elif el.get("type") == "relation":
            segments = [
                [(g["lon"], g["lat"]) for g in m.get("geometry", []) if "lon" in g and "lat" in g]
                for m in el.get("members", [])
                if m.get("type") == "way" and m.get("role") in (None, "", "outer")
            ]
            remaining = [s for s in segments if len(s) >= 2]
            while remaining:
                chain = remaining.pop(0)
                changed = True
                while changed and remaining:
                    changed = False
                    for i, seg in enumerate(remaining):
                        if chain[-1] == seg[0]:
                            chain.extend(seg[1:])
                        elif chain[-1] == seg[-1]:
                            chain.extend(reversed(seg[:-1]))
                        elif chain[0] == seg[-1]:
                            chain = seg[:-1] + chain
                        elif chain[0] == seg[0]:
                            chain = list(reversed(seg[1:])) + chain
                        else:
                            continue
                        remaining.pop(i)
                        changed = True
                        break
                ring_of(chain)
    return rings


# --- sheet segmentation (Modul-2 template heuristics, straight from the prototype) -----------


def _components(mask: np.ndarray, min_area: int) -> list[tuple[int, np.ndarray, tuple[float, float], int]]:
    n, labels, stats, centers = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    out = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        w = int(stats[i, cv2.CC_STAT_WIDTH])
        h = int(stats[i, cv2.CC_STAT_HEIGHT])
        if area >= min_area and w >= 10 and h >= 10:
            out.append((i, labels == i, tuple(centers[i]), area))
    return out


def _grey_footprints(img: np.ndarray) -> np.ndarray:
    """Raw mask of neutral mid-grey filled polygons inside the map frame (text and cadastral
    lines are dark/thin and removed by the 9×9 opening)."""
    b, g, r = cv2.split(img)
    h, w = img.shape[:2]
    roi = np.zeros((h, w), np.uint8)
    roi[int(h * 0.045) : int(h * 0.89), int(w * 0.045) : int(w * 0.96)] = 1
    spread = np.maximum.reduce([r, g, b]).astype(int) - np.minimum.reduce([r, g, b]).astype(int)
    val = (r.astype(int) + g.astype(int) + b.astype(int)) / 3
    raw = ((spread < 13) & (val > 105) & (val < 225) & (roi > 0)).astype(np.uint8) * 255
    raw = cv2.morphologyEx(raw, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    return cv2.morphologyEx(raw, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))


def plan_focus_mask_red(img: np.ndarray) -> np.ndarray:
    """The Modul-1 Einsatzobjekt: the salmon/red filled compound (entrance arrows are red too,
    so the union grows only around the largest filled red region). Straight from the prototype's
    module-1 branch; the page ROI ends at 76 % — below sit Sofortmassnahmen/Bemerkungen."""
    b, g, r = cv2.split(img)
    h, w = img.shape[:2]
    roi = np.zeros((h, w), np.uint8)
    roi[int(h * 0.045) : int(h * 0.76), int(w * 0.045) : int(w * 0.96)] = 1
    raw: np.ndarray = (
        (r > 150)
        & (r.astype(int) > g.astype(int) + 28)
        & (r.astype(int) > b.astype(int) + 20)
        & (g > 55)
        & (b < 190)
        & (roi > 0)
    ).astype(np.uint8) * 255
    raw = cv2.morphologyEx(raw, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    comps = _components(raw, 180)
    if not comps:
        raise ValueError("no red object footprint found")
    largest = max(comps, key=lambda c: c[3])
    cx, cy = largest[2]
    keep = [c for c in comps if c[3] >= 180 and math.hypot(c[2][0] - cx, c[2][1] - cy) < 0.24 * math.hypot(w, h)]
    mask = np.zeros((h, w), np.uint8)
    for _, part, _, _ in keep:
        mask[part] = 255
    return mask


def plan_focus_mask(img: np.ndarray) -> np.ndarray:
    """The Einsatzobjekt compound: the substantial grey component nearest the map centre
    (area-weighted, so a legend swatch cannot win), plus its close neighbours."""
    h, w = img.shape[:2]
    comps = _components(_grey_footprints(img), 500)
    if not comps:
        raise ValueError("no grey building footprint found")
    target = np.array([w * 0.50, h * 0.44])
    diag = math.hypot(w, h)
    largest = max(comps, key=lambda c: math.log(c[3]) - 4.2 * float(np.linalg.norm(np.array(c[2]) - target)) / diag)
    cx, cy = largest[2]
    keep = [
        c for c in comps if c[3] >= max(450, largest[3] * 0.04) and math.hypot(c[2][0] - cx, c[2][1] - cy) < 0.16 * diag
    ]
    mask = np.zeros((h, w), np.uint8)
    for _, part, _, _ in keep:
        mask[part] = 255
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))


def plan_context_mask(img: np.ndarray) -> np.ndarray:
    """All substantial filled building footprints, not just the Einsatzobjekt compound."""
    h, w = img.shape[:2]
    comps = _components(_grey_footprints(img), 500)
    mask = np.zeros((h, w), np.uint8)
    for _, part, _, area in comps:
        # a page-wide grey furniture/background block is not a building
        if area < h * w * 0.09:
            mask[part] = 255
    return mask


def boundary_from_mask(mask: np.ndarray, limit: int) -> np.ndarray:
    """Sub-sampled boundary of every substantial contour, y flipped UP to match metres."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    kept = [c[:, 0, :] for c in contours if cv2.contourArea(c) > 100]
    if not kept:
        raise ValueError("no boundary contours found")
    pts = np.concatenate(kept, axis=0).astype(np.float64)
    if len(pts) > limit:
        pts = pts[np.linspace(0, len(pts) - 1, limit).astype(int)]
    pts[:, 1] *= -1
    return pts


# --- registration ----------------------------------------------------------------------------


def _sampled_ring(ring: np.ndarray, step: float) -> np.ndarray:
    out = []
    for a, b in zip(ring, np.vstack([ring[1:], ring[:1]]), strict=True):
        n = max(2, int(np.linalg.norm(b - a) / step) + 1)
        out.append(np.linspace(a, b, n, endpoint=False))
    return np.concatenate(out)


def _fixed_scale_similarity(src: np.ndarray, dst: np.ndarray, scale: float) -> tuple[np.ndarray, np.ndarray]:
    sx = src.mean(0)
    sy = dst.mean(0)
    x = (src - sx) * scale
    y = dst - sy
    u, _, vt = np.linalg.svd(x.T @ y)
    rot = vt.T @ u.T
    if np.linalg.det(rot) < 0:  # a similarity, never a mirror — see src/lib/georef.ts
        vt[-1] *= -1
        rot = vt.T @ u.T
    a = scale * rot
    return a, sy - sx @ a.T


def context_icp(
    focus: np.ndarray,
    context: np.ndarray,
    rings: list[np.ndarray],
    expected_scale: float,
    *,
    compound: bool = False,
) -> Suggestion:
    """Register building context at fixed printed scale, with a coarse-to-fine search.

    Explore every seed/rotation on a deterministic sparse boundary, then spend the full
    refinement budget on 24 distinct poses. A red operational compound can span several
    OSM buildings: its focus is scored against their union, never a single seed footprint.
    The score is a ranking heuristic, neither metres nor a confidence percentage.
    """
    if not rings:
        raise ValueError("no OSM building rings around the object")
    dst = np.concatenate([_sampled_ring(r, 1.3) for r in rings])
    tree = cKDTree(dst)
    centers = np.array([r.mean(0) for r in rings])
    seeds = np.argsort(np.linalg.norm(centers, axis=1))[:20]
    focus_center = focus.mean(0)
    focus_trees = {int(seed): tree if compound else cKDTree(_sampled_ring(rings[seed], 1.0)) for seed in seeds}

    def refine(src: np.ndarray, a: np.ndarray, t: np.ndarray, iterations: int) -> tuple[np.ndarray, np.ndarray]:
        for _ in range(iterations):
            distances, ix = tree.query(src @ a.T + t)
            cutoff = min(12.0, float(np.quantile(distances, 0.62)))
            use = distances <= cutoff
            if np.count_nonzero(use) < 24:
                break
            na, nt = _fixed_scale_similarity(src[use], dst[ix[use]], expected_scale)
            converged = np.max(np.abs(na - a)) < 1e-7 and np.max(np.abs(nt - t)) < 1e-4
            a, t = na, nt
            if converged:
                break
        return a, t

    def quality(src: np.ndarray, a: np.ndarray, t: np.ndarray, seed: int) -> tuple[float, float]:
        distances = tree.query(src @ a.T + t)[0]
        trimmed = np.sort(distances)[: max(1, int(len(distances) * 0.72))]
        coverage = float(np.mean(distances < 2.4))
        focus_moved = focus @ a.T + t
        focus_distances = focus_trees[seed].query(focus_moved)[0]
        focus_error = float(np.mean(np.sort(focus_distances)[: max(1, int(len(focus_moved) * 0.75))]))
        anchor_distance = float(np.linalg.norm(focus_moved.mean(0)))
        score = float(np.mean(trimmed)) + 0.45 * focus_error + 0.012 * min(anchor_distance, 100) - 2.2 * coverage
        return score, coverage

    coarse = context[np.linspace(0, len(context) - 1, min(360, len(context))).astype(int)]
    candidates = []
    for seed in seeds:
        for deg in range(0, 360, 10):
            rad = math.radians(deg)
            a = expected_scale * np.array([[math.cos(rad), -math.sin(rad)], [math.sin(rad), math.cos(rad)]])
            t = centers[seed] - focus_center @ a.T
            a, t = refine(coarse, a, t, 16)
            score, _ = quality(coarse, a, t, int(seed))
            candidates.append((score, a, t, int(seed)))

    # Many seeds converge on the same pose. Keep spatial/rotational diversity so repeated
    # rows cannot consume the whole fine-search budget with copies of one local minimum.
    distinct: list[tuple[np.ndarray, np.ndarray]] = []
    best: tuple[float, np.ndarray, np.ndarray, float] | None = None
    for _, a, t, seed in sorted(candidates, key=lambda c: c[0]):
        center = focus_center @ a.T + t
        if any(
            np.linalg.norm(center - previous_center) < 3 and np.max(np.abs(a - previous_a)) < expected_scale * 0.035
            for previous_a, previous_center in distinct
        ):
            continue
        distinct.append((a, center))
        a, t = refine(context, a, t, 70)
        score, coverage = quality(context, a, t, seed)
        if best is None or score < best[0]:
            best = (score, a, t, coverage)
        if len(distinct) >= 24:
            break
    if best is None:
        raise ValueError("registration produced no candidate")
    score, a, t, coverage = best
    return Suggestion(
        a=a,
        t=t,
        score=score,
        coverage=coverage,
        rotation_deg=math.degrees(math.atan2(a[1, 0], a[0, 0])),
    )


def suggest(img_bgr: np.ndarray, m_per_px: float, rings: list[np.ndarray], template: str = "m2") -> Suggestion:
    """The whole pipeline for one rendered sheet. `template` picks the focus segmentation:
    'm1' anchors on the red Einsatzobjekt compound, everything else on the central grey one.
    Raises ValueError when segmentation finds nothing to match — the caller turns that into
    «kein Vorschlag», not a 500."""
    focus_mask = plan_focus_mask_red(img_bgr) if template == "m1" else plan_focus_mask(img_bgr)
    focus = boundary_from_mask(focus_mask, 700)
    context = boundary_from_mask(plan_context_mask(img_bgr), 1800)
    return context_icp(focus, context, rings, m_per_px, compound=template == "m1")


def suggestion_pairs(
    s: Suggestion,
    img_w: int,
    img_h: int,
    anchor_lng: float,
    anchor_lat: float,
) -> list[dict]:
    """The transform as two reference pairs at the sheet's inset diagonal corners.

    Two pairs carry a similarity exactly and honestly: the client's own fit re-derives the
    same transform, `residualClaim` refuses to print a number at n = 2, and the lamp reads
    «exakt, aber ungeprüft» — which is precisely what an unreviewed proposal is. Deliberately
    NOT more pairs: extra points derived from the same fit would manufacture a zero residual
    that looks like independent evidence (experiment README, «Fit with the current app»).
    """
    out = []
    for nx, ny in ((PAIR_INSET, PAIR_INSET), (1 - PAIR_INSET, 1 - PAIR_INSET)):
        px = np.array([nx * img_w, -(ny * img_h)])  # sheet px, y flipped up
        mx, my = px @ s.a.T + s.t
        lng, lat = local_to_wgs84(float(mx), float(my), anchor_lng, anchor_lat)
        out.append({"plan": {"x": nx, "y": ny}, "lngLat": {"lng": lng, "lat": lat}, "kind": "auto"})
    return out
