"""§-Marker: the plan author prepares the floor pack and the map fit IN the PDF.

Every plan arrives here the same way (`plans.store_plan`), and until now every floor pack and
every map fit was assembled by hand afterwards in the admin UI — for 150 objects, once per
re-export. The person who actually knows which drawing is which Geschoss, and where the
building's corner sits in LV95, is the one drawing the sheet. So they say it *on* the sheet:

    §EG                     this drawing is the Erdgeschoss; the text box centre is its join point
    §1OG  §2UG  §DG         …one storey above / two below / the Dachgeschoss
    §0  §+1  §-1            the same, said as a signed index
    §0 Erdgeschoss          …with the name the admin would otherwise have typed
    §1OG.B                  …at the point called «B», when one staircase does not run through
    §1OG.B Nordtreppe       …the same, named
    §[EG   §EG]             the Erdgeschoss drawing's region: top-left and bottom-right corner
    §GEO 2612345.6 1264321.2   this point is that LV95 coordinate (WGS84 lat lon also works)

Nothing else changes: the tags are ordinary text spans (white, 2pt, off in a corner — PDFium
reads them either way), so a marked-up sheet still prints and opens exactly as before.

**The grammar, exactly.** A marker is one text span starting with ``§``. Case-insensitive,
whitespace-tolerant. The span's BOUNDING-BOX CENTRE is the point the marker states — its join
point, its region corner, its geo landmark — so the author positions the text box, not its
first glyph. **A tag is one TEXT OBJECT** (README, Platzierungsregel 7), and that is how it is
read back: PDFium's own object boundaries delimit the span, never a gap heuristic over a
character stream (see `_runs`).

``EG`` = 0, ``nOG`` = +n, ``nUG`` = −n, ``DG`` = the highest OG + 1 (and +1 when there is no
OG); the level-0 drawing's page is the pack's ONE fit page, and two or more ``§GEO`` markers on
it are the fit's landmark pairs. Everything is normalized page coordinates, y down — the same
space as ``PlanFloor.clip``/``join`` and ``GeorefPair.plan``.

A floor may state SEVERAL points, one per ``.label`` — no building owes its plan one staircase
that runs from the Tiefgarage to the Dachstock. Two floors that share a label are joined at it,
and the joins chain: EG–1OG at ``A``, 1OG–2OG at ``B`` still lays all three on one frame.

A floor may also be DRAWN SEVERAL TIMES (16.09.2026): a long building whose 1. OG exists as two
drawings, one per wing. Each ``§[1OG`` / ``§1OG]`` corner pair delimits one *region* of storey
+1, and the region that contains ``§1OG.A`` joins the EG drawing carrying ``§EG.A`` while the one
containing ``§1OG.B`` joins the one carrying ``§EG.B``. The corners may SAY which drawing they
delimit instead of leaving it to containment — ``§[1OG.A`` … ``§1OG.A]`` are the corners of the
drawing whose join tag is ``§1OG.A`` — and that is the recommended spelling, because it no longer
depends on where in the rectangle the author dropped the join tag. Named and unnamed pairs may be
mixed on one storey. The regions of a storey are its ``PlanFloor.part``s, in reading order. A
second UNNAMED region with no join tag inside it is refused (`part_without_join`) rather than
guessed at, and a NAMED pair whose join tag the sheet never states is refused the same way
(`corner_stray`): nothing on the sheet says where that drawing lies.

This module is pure: it reads bytes and returns a proposal. Who writes it, and what it may
overwrite, is `plan_alignment_worker`'s business. ``python -m app.plan_markers <pdf>`` prints
what a given export says, which is the plan author's dry run (``just plan-markers``).
"""

from __future__ import annotations

import argparse
import ctypes
import math
import re
import sys
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal, TypedDict

from . import storage
from .geo_util import lv95_to_wgs84
from .pdfium_lock import pdfium_lock
from .plan_floors import FloorError, PlanFloor, default_fit_page, validate_floors

#: the same page cap the renderer holds a document to (plan_alignment_compute.MAX_PAGES)
MAX_PAGES = 100
#: a tag longer than this is prose that happens to contain a «§», not a marker
MAX_TAG_CHARS = 96
#: anything shorter than this fraction of the run's tallest glyph is not a glyph but a box
#: PDFium generated (the space it inserts between two text objects has no height at all)
_MIN_GLYPH = 0.2
#: how far to the right of a bare «§GEO» its numbers may sit — in text heights — and still be
#: the same statement, typed into a second frame (see `_join_geo`)
_GEO_GAP = 3.0
#: the point a storey tag states when it names none – «§1OG» ≡ «§1OG.A», so a sheet drawn before
#: labels existed says «every floor meets every other at A», which is one staircase for all
DEFAULT_LABEL = "A"

MarkerKind = Literal["floor", "corner_tl", "corner_br", "geo", "unknown"]

#: What a marked-up export can get wrong, as a CLOSED set of codes (16.09.2026). A warning used
#: to be one free-text sentence, half English and half German, which meant the only place it
#: could be shown was a log — and an admin looking at «Vorschlag bereit» with zero Geschosse had
#: no way to learn that a «§4OG]» was missing. The code is the fact; `text()` renders it for the
#: CLI and the log, `admin.alignment.markerWarnings.<code>` renders it for the admin UI.
WarningCode = Literal[
    "unknown_tag",  # a «§» span the grammar does not know – a typo
    "page_rotated",  # a marked page carries /Rotate; its boxes are read in the unturned frame
    "duplicate_storey",  # the same storey + point label marked twice
    "storey_page_split",  # a storey's further points sit on another page than its drawing
    "no_level_zero",  # no §EG / §0 – the fit page has to be guessed
    "no_shared_join",  # a storey shares no point label with the chain, so it hangs free
    "corner_missing",  # one region corner without its counterpart
    "corner_stray",  # region corners for a storey no §-marker declares
    "part_without_join",  # a storey drawn twice, with only one join tag – nothing places the other
    "region_off_page",  # a region corner's text box sits outside the page
    "region_page_split",  # a storey's region corners are not on its drawing's page
    "join_outside_region",  # a storey's own join tag lies outside the region its corners state
    "geo_off_fit_page",  # §GEO on a page that is not the pack's one fit page
    "geo_duplicate",  # a §GEO repeating a point already paired
    "geo_single",  # exactly one §GEO – a fit needs two
    "pack_invalid",  # the storeys together make no pack `validate_floors` would accept
]


class _WarningFields(TypedDict, total=False):
    """Whatever the code needs to be said in a sentence; each code fills a fixed few."""

    #: the signed storey index the warning is about (0 = EG, +1 = 1. OG …)
    storey: int
    #: which DRAWING of that storey, 0-based – only carried when it is not the first
    part: int
    #: the tag the author still has to write (`part_without_join`)
    want: str
    #: the storey's point label – «A» where the author named none
    label: str
    #: the tag as written, «§» included – the thing the author has to go and fix
    tag: str
    #: the tag's counterpart that IS there (`corner_missing`)
    have: str
    #: which region corner is missing: top-left or bottom-right
    side: Literal["tl", "br"]
    #: 1-BASED, as the author counts pages in their PDF viewer
    page: int
    other: int
    #: the axis and value that left the page (`region_off_page`)
    axis: Literal["x", "y"]
    value: float
    count: int
    #: `validate_floors`' own German sentence, for `pack_invalid`
    detail: str


class MarkerWarning(_WarningFields):
    code: WarningCode


@dataclass(frozen=True, slots=True)
class Marker:
    """One ``§`` span as it stands on the page, parsed but not yet reconciled with the others."""

    page: int
    kind: MarkerKind
    #: the tag as written, «§» included – what the CLI echoes and a warning names
    text: str
    #: the span's bounding-box centre, normalized 0..1 of the page, y DOWN
    x: float
    y: float
    #: storey index; None on a ``§DG`` (resolved against the plan's OG storeys) and on non-floors
    index: int | None = None
    dach: bool = False
    #: which of the drawing's points this marker states – «§1OG.B» → ``"B"``. A STOREY tag that
    #: names none states ``A`` (`DEFAULT_LABEL`); a REGION CORNER that names none states nothing
    #: (``""``) and is paired with its nearest counterpart rather than by name.
    label: str = DEFAULT_LABEL
    #: the display name after the storey token, when the author wrote one
    name: str | None = None
    #: the page carries a /Rotate – the fit reads it turned, these boxes are in the flat frame
    rotated: bool = False
    lng: float | None = None
    lat: float | None = None

    @property
    def point(self) -> list[float]:
        return [self.x, self.y]


@dataclass(frozen=True, slots=True)
class MarkerPlan:
    """What a marked-up PDF proposes: a floor pack, its fit page, and maybe the fit itself."""

    floors: list[PlanFloor]
    #: the page the pack's ONE map fit is measured on — the level-0 drawing's
    fit_page: int
    #: the document's page count, so a merge can re-validate without re-opening the PDF
    page_count: int
    #: ``GeorefPair`` dicts from the ``§GEO`` markers on the fit page; < 2 of them means none
    pairs: list[dict]
    #: what the author should fix, as codes; a plan is still returned around them
    warnings: list[MarkerWarning]
    #: the storey index every join chain ends at – the level-0 drawing's, or the nearest to it
    reference: int = 0
    #: how many storeys the markers DECLARED – which is not ``len(floors)`` when they together
    #: make no valid pack, and is what the admin row's summary reports against what was written
    storeys: int = 0


# ---------------------------------------------------------------------------------------
# the grammar
# ---------------------------------------------------------------------------------------

_STOREY_RE = re.compile(
    r"""^(?:
          (?P<eg>EG)
        | (?P<dg>DG)
        | (?P<n>\d+)\s*(?P<level>OG|UG)
        | (?P<bare>OG|UG)
        | (?P<signed>[-+]?\d+)
    )$""",
    re.IGNORECASE | re.VERBOSE,
)
_NUMBER_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")
#: The point label of a storey tag: everything after the LAST dot of the storey TOKEN, and only
#: when it is 1–8 letters/digits — «§1OG.B», «§EG.T2». The token ends at the first space, so a
#: display name can never be read as a label («§0 1. Stock» is the name «1. Stock»), and a
#: storey token itself never contains a dot, so the two halves cannot collide.
_LABEL_RE = re.compile(r"^(?P<storey>.+)\.(?P<label>[A-Za-z0-9]{1,8})$")
#: an LV95 easting/northing is millions of metres; a WGS84 degree never is
_LV95_FLOOR = 1000.0


def _storey(token: str) -> tuple[int | None, bool] | None:
    """``"1OG"`` → (1, False), ``"DG"`` → (None, True), anything else → None."""
    m = _STOREY_RE.match(token.strip())
    if m is None:
        return None
    if m["eg"]:
        return 0, False
    if m["dg"]:
        return None, True
    if m["n"]:
        return (int(m["n"]) if m["level"].upper() == "OG" else -int(m["n"])), False
    if m["bare"]:
        return (1 if m["bare"].upper() == "OG" else -1), False
    return int(m["signed"]), False


def _point_token(token: str) -> tuple[int | None, bool, str] | None:
    """``"1OG.B"`` → (1, False, "B"), ``"EG"`` → (0, False, "A"), anything else → None."""
    m = _LABEL_RE.match(token.strip())
    base, label = (m["storey"], m["label"].upper()) if m else (token, DEFAULT_LABEL)
    storey = _storey(base)
    return None if storey is None else (storey[0], storey[1], label)


def _corner(kind: MarkerKind, token: str) -> dict | None:
    """``"1OG"`` → the +1 corner, ``"1OG.A"`` → the corner of that storey's «A» drawing.

    A region corner MAY carry the point label of the drawing it delimits (16.09.2026): ``§[1OG.A``
    … ``§1OG.A]`` are the corners of the drawing whose join tag is ``§1OG.A``. One that names none
    states ``""`` — not ``A`` — because «no name» is what tells `_pair_regions` to fall back on
    nearest-corner pairing, and a sheet may mix the two spellings on one storey.
    """
    m = _LABEL_RE.match(token.strip())
    base, label = (m["storey"], m["label"].upper()) if m else (token, "")
    storey = _storey(base)
    return None if storey is None else {"kind": kind, "index": storey[0], "dach": storey[1], "label": label}


def _geo(rest: str) -> tuple[float, float] | None:
    """``"2612345.6 1264321.2"`` → (lng, lat). LV95 or WGS84, decided by magnitude."""
    nums = _NUMBER_RE.findall(rest)
    if len(nums) < 2:
        return None
    a, b = float(nums[0]), float(nums[1])
    lat, lng = lv95_to_wgs84(a, b) if abs(a) >= _LV95_FLOOR or abs(b) >= _LV95_FLOOR else (a, b)
    if not all(math.isfinite(v) for v in (lat, lng)) or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    return lng, lat


def parse_tag(text: str) -> dict | None:
    """The grammar, and only the grammar: tag text → the fields of a `Marker`, or None.

    None means «starts with § but says nothing this system understands» — the caller turns that
    into an `unknown` marker so the author hears about a typo instead of silence.
    """
    body = text.lstrip("§").strip()
    if not body:
        return None
    if body.upper().startswith("GEO"):
        point = _geo(body[3:])
        return None if point is None else {"kind": "geo", "lng": point[0], "lat": point[1]}
    if body.startswith("["):
        return _corner("corner_tl", body[1:])
    if body.endswith("]"):
        return _corner("corner_br", body[:-1])
    # «1 OG» is one token with a space in it, «0 Erdgeschoss» is a token and a name – so the
    # whole body is offered to the grammar first, and only a body it rejects is split.
    spot = _point_token(body)
    name = ""
    if spot is None:
        token, _, name = body.partition(" ")
        spot = _point_token(token)
    if spot is None:
        return None
    index, dach, label = spot
    return {
        "kind": "floor",
        "index": index,
        "dach": dach,
        "label": label,
        "name": name.strip() or ("DG" if dach else None),
    }


# ---------------------------------------------------------------------------------------
# reading them off the page
# ---------------------------------------------------------------------------------------


#: a character's box on the page, in PDF space (left, bottom, right, top), y UP
Box = tuple[float, float, float, float]


@dataclass(frozen=True, slots=True)
class _Run:
    """One text object's characters and the box PDFium drew each of them in, index-aligned."""

    text: str
    boxes: list[Box | None]

    def bbox(self, begin: int, end: int) -> Box | None:
        """The rectangle ``text[begin:end]`` covers, or None when none of it was placed."""
        drawn = [b for b in self.boxes[begin:end] if b is not None and b[2] > b[0] and b[3] > b[1]]
        if not drawn:
            return None
        # PDFium gives the space it inserts between two text objects a box with no height at
        # all; a glyph that small is not part of the tag's rectangle
        tall = max(b[3] - b[1] for b in drawn)
        glyphs = [b for b in drawn if b[3] - b[1] >= _MIN_GLYPH * tall] or drawn
        return (
            min(b[0] for b in glyphs),
            min(b[1] for b in glyphs),
            max(b[2] for b in glyphs),
            max(b[3] for b in glyphs),
        )


def _object_id(text_page: Any, index: int) -> int | None:
    """Which TEXT OBJECT drew the character at ``index`` — its handle, as a plain address.

    PDFium hands the same object out as a fresh wrapper per call, and a ctypes pointer compares
    by Python identity, so the address is the only thing two calls can be asked to agree on.
    None is a character no object owns: the ``\r\n`` PDFium generates between two objects.
    """
    obj = text_page.get_textobj(index)
    return None if obj is None else ctypes.cast(obj.raw, ctypes.c_void_p).value


def _objects(text_page: Any, count: int) -> Iterator[tuple[int, int]]:
    """The page's characters as one index range per text object, in the document's own order."""
    start, current = 0, _object_id(text_page, 0)
    for i in range(1, count):
        key = _object_id(text_page, i)
        if key != current:
            yield start, i
            start, current = i, key
    yield start, count


def _charbox(text_page: Any, index: int) -> Box | None:
    try:
        return text_page.get_charbox(index)
    except (RuntimeError, ValueError):  # a generated \r\n has no box
        return None


def _object_run(text_page: Any, start: int, stop: int) -> _Run:
    """One text object's text, with every character's box beside it.

    ⚠️ **PDFium's character list and its text are two different sequences.** Wherever a glyph
    maps to no character the char list keeps it and ``FPDFText_GetText`` drops it, so
    ``get_text_range(0, count)`` MUST NOT be indexed positionally: from the first such glyph on,
    ``text[i]`` and ``get_charbox(i)`` describe different characters. The Tramdepot A0 export
    (Affinity Designer 2) has five of them near the start of the sheet, which is why every one of
    its 22 tags used to come out with a stranger's letters and a stranger's position. The text is
    therefore read per OBJECT — where the two agree for every export seen so far — and re-read
    character by character whenever the two lengths still disagree.
    """
    n = stop - start
    text = text_page.get_text_range(start, n)
    if len(text) == n:
        return _Run(text, [_charbox(text_page, start + i) for i in range(n)])
    chars = [text_page.get_text_range(start + i, 1) for i in range(n)]
    return _Run("".join(chars), [_charbox(text_page, start + i) for i, c in enumerate(chars) for _ in c])


def _tag_end(text: str, begin: int) -> int:
    """Where the tag that starts at ``text[begin]`` ends — which is not always the run's end.

    A region corner is exactly its token: the Tramdepot sheet's «§2OG]» stands in the title block
    right beside «08.12.2016 Vun», and a reader that swallowed the date would place the corner at
    the middle of the line instead of on the corner. A «§GEO» ends after its second number. Only a
    storey tag runs on, because its display name may carry spaces — and even that stops where the
    next «§» begins, so two tags sharing one frame stay two tags.
    """
    stop = text.find("§", begin + 1)
    if stop < 0:
        stop = len(text)
    body = text[begin + 1 : stop]
    head = body.lstrip()
    offset = stop - len(head)
    if head.upper().startswith("GEO"):
        numbers = list(_NUMBER_RE.finditer(head))
        return offset + (numbers[1].end() if len(numbers) >= 2 else 3)
    token = head.split()[0] if head.split() else ""
    return offset + len(token) if token.startswith("[") or token.endswith("]") else stop


def _join_geo(runs: list[_Run]) -> list[_Run]:
    """«§GEO» and the numbers the author typed into a SECOND frame are one statement.

    The one merge this reader still does across text objects, and it is deliberate: a bare «§GEO»
    states nothing, so the only way it can be a tag at all is with numbers that follow it on the
    same baseline. Nothing else is merged — two storey tags that happen to share a baseline stay
    two tags, which is exactly what the gap heuristic this replaced got wrong.
    """
    bare = [r for r in runs if r.text.strip().upper() == "§GEO"]
    if not bare:
        return runs
    tails = [(r, r.bbox(0, len(r.text))) for r in runs if r.text.strip() and "§" not in r.text]
    merged: dict[int, _Run] = {}
    for run in bare:
        box = run.bbox(0, len(run.text))
        near = [(r, b) for r, b in tails if _follows(box, b)]
        if near:
            numbers = min(near, key=lambda pair: pair[1][0] if pair[1] else 0.0)[0]
            merged[id(run)] = _Run(run.text.rstrip() + " " + numbers.text, [*run.boxes, None, *numbers.boxes])
    return [merged.get(id(r), r) for r in runs]


def _follows(geo: Box | None, numbers: Box | None) -> bool:
    """Does ``numbers`` sit on ``geo``'s baseline, just to its right?"""
    if geo is None or numbers is None:
        return False
    height = geo[3] - geo[1]
    return abs(numbers[1] - geo[1]) <= 0.4 * height and -0.2 * height <= numbers[0] - geo[2] <= _GEO_GAP * height


def _runs(text_page: Any) -> list[tuple[str, Box]]:
    """Every ``§`` tag on one page as (tag text, bounding box) — one TEXT OBJECT at a time.

    A tag is one text object (README, Platzierungsregel 7), so PDFium's own object boundaries are
    the segmentation: no gap, line or baseline heuristic decides where a tag starts or stops, and
    two tiny tags on a shared baseline — or a sheet whose objects come out in a different order
    than they are drawn — cannot be glued into one span. `_join_geo` is the single documented
    exception, and `_tag_end` cuts a tag short where its own grammar ends.
    """
    count = text_page.count_chars()
    if not count or "§" not in text_page.get_text_range(0, count):
        return []  # the overwhelming majority of plan pages, read with one call
    runs = [_object_run(text_page, start, stop) for start, stop in _objects(text_page, count)]
    out: list[tuple[str, Box]] = []
    for run in _join_geo(runs):
        if "§" not in run.text:
            continue
        begin = -1
        while (begin := run.text.find("§", begin + 1)) >= 0:
            end = min(_tag_end(run.text, begin), begin + MAX_TAG_CHARS)
            box = run.bbox(begin, end)
            if box is not None:  # a «§» PDFium placed nowhere cannot state a position
                out.append((run.text[begin:end].rstrip(), box))
    return out


def extract_markers(source: bytes | str) -> list[Marker]:
    """Every ``§`` span of a PDF (raw bytes, or an immutable storage key), page by page.

    Called from a worker thread — it holds PDFium's process-wide lock through every object's
    closure, exactly like `plan_alignment_compute.render_page`, and reads text only: no raster,
    no fonts, no network. A page turned by ``/Rotate`` is read but flagged (see
    `plan_from_markers`), because its character boxes are in the unrotated frame the fit is not.
    """
    return _read(source)[0]


def read_plan(source: bytes | str) -> MarkerPlan | None:
    """Markers → proposal in ONE PDFium open; the worker's single blocking call."""
    markers, page_count = _read(source)
    return plan_from_markers(markers, page_count)


def _read(source: bytes | str) -> tuple[list[Marker], int]:
    import pypdfium2 as pdfium

    data = source if isinstance(source, bytes) else storage.get_bytes(source)
    markers: list[Marker] = []
    with pdfium_lock:
        document = pdfium.PdfDocument(data)
        try:
            for number in range(min(len(document), MAX_PAGES)):
                page = document[number]
                try:
                    width, height = page.get_size()
                    if not all(math.isfinite(v) and v > 0 for v in (width, height)):
                        continue
                    rotated = bool(getattr(page, "get_rotation", lambda: 0)())
                    text_page = page.get_textpage()
                    try:
                        tags = _runs(text_page)
                    finally:
                        text_page.close()
                finally:
                    page.close()
                for span, (bx0, by0, bx1, by1) in tags:
                    fields = parse_tag(span) or {"kind": "unknown"}
                    markers.append(
                        Marker(
                            page=number,
                            text=span,
                            # PDF space is y UP from the bottom-left; every consumer of these
                            # numbers (clip, join, GeorefPair.plan) reads y DOWN from the top.
                            x=(bx0 + bx1) / 2 / width,
                            y=1.0 - (by0 + by1) / 2 / height,
                            rotated=rotated,
                            **fields,
                        )
                    )
            page_count = len(document)
        finally:
            document.close()
    return markers, page_count


# ---------------------------------------------------------------------------------------
# …and what they add up to
# ---------------------------------------------------------------------------------------


def _resolve_dach(markers: list[Marker]) -> list[Marker]:
    """``§DG`` is «one above the top storey», which only the whole sheet can say.

    Idempotent: a ``§DG`` that already carries its resolved index is not one of the storeys it
    is resolved against, so running this twice (the CLI prints resolved markers and then asks
    for the plan) cannot walk the roof up a floor per pass.
    """
    above = [m.index for m in markers if m.kind == "floor" and not m.dach and m.index is not None and m.index > 0]
    dach = (max(above) if above else 0) + 1
    return [replace(m, index=dach) if m.dach else m for m in markers]


#: one DRAWING of the pack: which storey, and which of that storey's drawings
Key = tuple[int, int]


def _chain(points: dict[Key, dict[str, Marker]], anchor: Key) -> tuple[dict[Key, dict], list[Key]]:
    """Which drawing joins which, and at which of its points – ONE join per drawing, chained.

    Two drawings are joinable where they share a point LABEL: «§1OG.B» and «§2OG.B» are the same
    staircase, «§EG.A» is a different one. Only a partner that already hangs on the ``anchor``
    may be picked, so every chain ends there and none can close on itself. Among those the
    anchor itself wins (one hop, no accumulated error — and the whole-building staircase every
    unlabelled sheet describes stays the star it is today), then the drawing one storey nearer
    the anchor, then the nearest one; ties go to the lower index so a sheet reads the same twice.
    Two drawings of the SAME storey never join each other: they are two wings of one floor, and
    a staircase they shared would be one drawing, not two.

    Returns the joins by drawing, and the drawings that share no point with the chain.
    """
    joins: dict[Key, dict] = {}
    resolved = {anchor}
    pending = sorted((k for k in points if k != anchor), key=lambda k: (abs(k[0] - anchor[0]), k[0], k[1]))
    while pending:
        for key in pending:
            index, _ = key
            step = index + (1 if anchor[0] > index else -1)
            best: tuple[tuple[int, int, int, int], Key, str] | None = None
            for other in sorted(resolved):
                if other[0] == index:
                    continue
                shared = sorted(set(points[key]) & set(points[other]))
                if not shared:
                    continue
                rank = (
                    0 if other == anchor else 1 if other[0] == step else 2,
                    abs(other[0] - index),
                    abs(other[0] - anchor[0]),
                    other[1],
                )
                if best is None or rank < best[0]:
                    best = (rank, other, shared[0])
            if best is None:
                continue
            _, other, label = best
            joins[key] = {
                "to": other[0],
                # part 0 is the whole world of every pack drawn one-floor-one-drawing, so it is
                # left unsaid: an older stored join and a fresh one for the same point stay the
                # same dict, which is what `admin_overrides` compares
                **({"part": other[1]} if other[1] else {}),
                "at": points[key][label].point,
                "there": points[other][label].point,
            }
            resolved.add(key)
            pending.remove(key)
            break  # the chain grew – re-scan, nearest the anchor first, against the new set
        else:
            break  # a full pass joined nothing: what is left shares no point with the chain
    return joins, pending


def _pair_regions(corners: list[Marker]) -> tuple[list[tuple[Marker, Marker]], list[Marker]]:
    """Corner marks of ONE storey → its rectangles, plus the corners that found no counterpart.

    A pair that NAMES a point is paired by that name, wherever on the sheet the two sit:
    ``§[1OG.A`` belongs to ``§1OG.A]``, and together they delimit the drawing the join tag
    ``§1OG.A`` places. Naming beats geometry, so a sheet whose wings interleave still reads
    (Grenzweg 1 – BLT Tramdepot, 16.09.2026, where Bastian wrote it this way before the grammar
    had it). Corners that name nothing keep the pairing they always had: read top-down, then
    left-right, each ``§[1OG`` takes the NEAREST unclaimed ``§1OG]`` below and to the right of it,
    so two drawings side by side pair within themselves rather than across the sheet. Named and
    unnamed pairs may be mixed on one storey. A corner whose twin was never drawn is handed back –
    it costs that one region, exactly as a lone corner always has.
    """
    pairs: list[tuple[Marker, Marker]] = []
    lonely: list[Marker] = []
    for label in sorted({m.label for m in corners if m.label}):
        named = [m for m in corners if m.label == label]
        tops = [m for m in named if m.kind == "corner_tl"]
        bottoms = [m for m in named if m.kind == "corner_br"]
        pairs += list(zip(tops, bottoms, strict=False))
        lonely += tops[len(bottoms) :] + bottoms[len(tops) :]

    free = [m for m in corners if not m.label and m.kind == "corner_br"]
    anonymous = (m for m in corners if not m.label and m.kind == "corner_tl")
    for tl in sorted(anonymous, key=lambda m: (round(m.y, 4), round(m.x, 4))):
        candidates = [m for m in free if m.x > tl.x and m.y > tl.y]
        if not candidates:
            continue
        br = min(candidates, key=lambda m: math.hypot(m.x - tl.x, m.y - tl.y))
        free = [m for m in free if m is not br]
        pairs.append((tl, br))
    taken = {id(m) for pair in pairs for m in pair} | {id(m) for m in lonely}
    return pairs, lonely + [m for m in corners if id(m) not in taken]


def _missing_corner(have: Marker) -> MarkerWarning:
    """The tag the author has to ADD, spelled the way they spelled its counterpart: «§[4OG» is
    there, so «§4OG]» is what is missing."""
    token = have.text.lstrip("§").strip().lstrip("[").rstrip("]")
    side: Literal["tl", "br"] = "br" if have.kind == "corner_tl" else "tl"
    return MarkerWarning(
        code="corner_missing",
        storey=have.index if have.index is not None else 0,
        tag=f"§{token}]" if side == "br" else f"§[{token}",
        have=have.text,
        side=side,
        page=have.page + 1,
    )


def _storey_tag(index: int) -> str:
    """The storey token as an author writes it – what a warning names when it asks for a tag."""
    return "§EG" if index == 0 else f"§{index}OG" if index > 0 else f"§{-index}UG"


def _free_label(used: set[str]) -> str:
    """The point name the author still has free on this storey – «B» beside an «A»."""
    return next((c for c in "ABCDEFGHJKLMNPQRSTUVWXYZ" if c not in used), "X")


def _inside(m: Marker, clip: list[float]) -> bool:
    return clip[0] <= m.x <= clip[2] and clip[1] <= m.y <= clip[3]


def _renumber(
    parts: dict[Key, dict[str, Marker]], clips: dict[Key, list[float] | None]
) -> tuple[dict[Key, dict[str, Marker]], dict[Key, list[float] | None]]:
    """The drawings of each storey numbered 0, 1, 2 … again after one of them was dropped —
    `PlanFloor.part` is a position in the storey, and a gap in it is not a pack."""
    kept_points: dict[Key, dict[str, Marker]] = {}
    kept_clips: dict[Key, list[float] | None] = {}
    for index in sorted({i for i, _ in parts}):
        for part, key in enumerate(sorted(k for k in parts if k[0] == index)):
            kept_points[(index, part)], kept_clips[(index, part)] = parts[key], clips[key]
    return kept_points, kept_clips


def plan_from_markers(markers: list[Marker], page_count: int) -> MarkerPlan | None:
    """Reconcile the markers of one document into a floor pack + a fit proposal.

    None means the sheet carries no storey marker at all — an unmarked PDF, which is most of
    them, and nothing here should touch it. Anything short of that is a plan WITH warnings: a
    duplicate storey, a lone region corner or a stray ``§GEO`` costs the author that one
    statement, never the whole pack, because half a pack is still most of the work done.
    """
    markers = _resolve_dach([m for m in markers if m.page < page_count])
    warnings: list[MarkerWarning] = [
        MarkerWarning(code="unknown_tag", tag=m.text, page=m.page + 1) for m in markers if m.kind == "unknown"
    ]
    if any(m.rotated for m in markers):
        warnings.append(MarkerWarning(code="page_rotated"))

    # a floor states one point per label; several labelled tags on one drawing are the several
    # staircases it shares with several other floors, and the FIRST tag is the drawing itself
    points: dict[int, dict[str, Marker]] = {}
    for m, index in ((m, m.index) for m in markers if m.kind == "floor" and m.index is not None):
        on = points.setdefault(index, {})
        if m.label in on:
            warnings.append(
                MarkerWarning(code="duplicate_storey", storey=index, label=m.label, tag=m.text, page=m.page + 1)
            )
            continue
        if on and m.page != next(iter(on.values())).page:
            warnings.append(
                MarkerWarning(
                    code="storey_page_split",
                    storey=index,
                    label=m.label,
                    tag=m.text,
                    page=m.page + 1,
                    other=next(iter(on.values())).page + 1,
                )
            )
            continue
        on[m.label] = m
    if not points:
        return None
    storeys = {index: next(iter(on.values())) for index, on in points.items()}
    if 0 not in storeys:
        warnings.append(MarkerWarning(code="no_level_zero"))

    # A corner whose text box sits OUTSIDE the page states a rectangle that is not on the sheet —
    # exactly what a stray marker left in a template does (Allschwilerstrasse 100, 16.09.2026).
    # It is dropped HERE rather than at `validate_floors`, so the author is told which tag to move
    # instead of being handed «Bereich ausserhalb der Seite» about the whole pack.
    corners: dict[int, list[Marker]] = {}
    for m, index in ((m, m.index) for m in markers if m.kind in ("corner_tl", "corner_br") and m.index is not None):
        axis: Literal["x", "y"] | None = "x" if not 0.0 <= m.x <= 1.0 else "y" if not 0.0 <= m.y <= 1.0 else None
        if axis is not None:
            warnings.append(
                MarkerWarning(
                    code="region_off_page",
                    storey=index,
                    tag=m.text,
                    page=m.page + 1,
                    axis=axis,
                    value=round(m.x if axis == "x" else m.y, 4),
                )
            )
            continue
        corners.setdefault(index, []).append(m)

    # …and the corners of one storey become its REGIONS, in reading order, each with the point
    # label it names (or «» where it names none). One region (or none) is the storey drawn once,
    # exactly as every pack before 16.09.2026; two are its two wings.
    regions: dict[int, list[tuple[list[float], str]]] = {}
    for index in sorted(corners):
        if index not in storeys:
            warnings.append(MarkerWarning(code="corner_stray", storey=index))
            continue
        page = storeys[index].page
        rectangles, lonely = _pair_regions(corners[index])
        boxes: list[tuple[list[float], str]] = []
        for tl, br in rectangles:
            if tl.page != page or br.page != page:
                warnings.append(MarkerWarning(code="region_page_split", storey=index, page=page + 1))
                continue
            if tl.label and tl.label not in points[index]:
                # a named pair says WHICH drawing it delimits, and that drawing has to be marked:
                # «§[1OG.B» … «§1OG.B]» without a «§1OG.B» places nothing, so it is not guessed at
                warnings.append(MarkerWarning(code="corner_stray", storey=index, label=tl.label))
                continue
            boxes.append(([min(tl.x, br.x), min(tl.y, br.y), max(tl.x, br.x), max(tl.y, br.y)], tl.label))
        for have in lonely:
            warnings.append(_missing_corner(have))
        regions[index] = sorted(boxes, key=lambda c: (round(c[0][1], 4), round(c[0][0], 4)))

    # Which point belongs to which drawing: the one the region NAMES, and otherwise the join tag
    # INSIDE the rectangle. A storey with one drawing keeps every point it states, wherever on the
    # page the author put the tag – that is how every existing sheet reads, and nothing here may
    # change it.
    parts: dict[Key, dict[str, Marker]] = {}
    clips: dict[Key, list[float] | None] = {}
    for index in sorted(storeys):
        on = points[index]
        boxes = regions.get(index, [])
        if len(boxes) <= 1:
            parts[(index, 0)] = on
            clips[(index, 0)] = boxes[0][0] if boxes else None
            # A join tag's centre is a point OF the drawing, so a region that holds none of the
            # storey's points frames something else – a «§EG]» dropped in the wrong place left the
            # Gymnasium's EG a strip 1 % of the sheet wide, with no warning at all (21.09.2026).
            # Said, never acted on: the one-drawing reading stays exactly what it was.
            if boxes and not any(_inside(m, boxes[0][0]) for m in on.values()):
                warnings.append(
                    MarkerWarning(
                        code="join_outside_region",
                        storey=index,
                        tag=storeys[index].text,
                        page=storeys[index].page + 1,
                    )
                )
            continue
        # a named region owns its point outright: no other drawing may claim it by containment
        named = {label for _, label in boxes if label}
        used, part = set(on), 0
        for nth, (box, label) in enumerate(boxes):
            mine = {lb: m for lb, m in on.items() if lb == label or (_inside(m, box) and lb not in named)}
            if not mine:
                free = _free_label(used)
                used.add(free)
                warnings.append(
                    MarkerWarning(
                        code="part_without_join",
                        storey=index,
                        part=nth,
                        tag=_storey_tag(index),
                        want=f"{_storey_tag(index)}.{free}",
                        page=storeys[index].page + 1,
                    )
                )
                continue
            parts[(index, part)], clips[(index, part)] = mine, box
            part += 1

    reference_index = 0 if 0 in storeys else min(storeys, key=lambda i: abs(i))
    reference = storeys[reference_index]
    # The reference storey's FIRST drawing is the frame; everything else – its own sibling wing
    # included – is placed by a join. A drawing of a several-times-drawn storey that reaches no
    # join has nothing to say where it lies, so it is dropped and named, never guessed at; the
    # remaining drawings renumber and the chain is walked again over what is left.
    joins: dict[Key, dict] = {}
    unjoined: list[Key] = []
    for _ in range(len(parts) + 1):
        joins, unjoined = _chain(parts, (reference_index, 0))
        counts = Counter(index for index, _ in parts)
        loose = [key for key in unjoined if counts[key[0]] > 1]
        if not loose:
            break
        for key in loose:
            # the tag that WOULD place it: the same point name on the reference storey, because
            # that is the drawing this wing has to meet
            label = sorted(parts[key])[0]
            warnings.append(
                MarkerWarning(
                    code="part_without_join",
                    storey=key[0],
                    part=key[1],
                    tag=_storey_tag(key[0]),
                    want=f"{_storey_tag(reference_index)}.{label}",
                    page=storeys[key[0]].page + 1,
                )
            )
            del parts[key], clips[key]
        parts, clips = _renumber(parts, clips)
    for key in unjoined:
        warnings.append(MarkerWarning(code="no_shared_join", storey=key[0]))

    floors: list[PlanFloor] = []
    for key in sorted(parts):
        index, part = key
        # A storey tag's own centre is a point of this drawing, and a point two drawings share
        # is what lays one on the other. One point is translation only, which is exactly what an
        # export that keeps scale and orientation across its pages needs.
        name = next((p.name for p in parts[key].values() if p.name), None)
        floors.append(PlanFloor(storeys[index].page, index, name, clips[key], joins.get(key), part=part))

    # the level-0 drawing's page IS the fit page; without one, the same rule the admin's own
    # «Ausrichtungsseite» falls back to (plan_floors.default_fit_page)
    guessed = default_fit_page(floors)
    fit_page = reference.page if 0 in storeys or guessed is None else guessed
    geo = [m for m in markers if m.kind == "geo"]
    elsewhere = [m for m in geo if m.page != fit_page]
    if elsewhere:
        warnings.append(MarkerWarning(code="geo_off_fit_page", count=len(elsewhere), page=fit_page + 1))
    pairs: list[dict] = []
    for m in (m for m in geo if m.page == fit_page):
        if any(p["plan"] == {"x": m.x, "y": m.y} or p["lngLat"] == {"lng": m.lng, "lat": m.lat} for p in pairs):
            warnings.append(MarkerWarning(code="geo_duplicate", tag=m.text, page=m.page + 1))
            continue
        pairs.append({"plan": {"x": m.x, "y": m.y}, "lngLat": {"lng": m.lng, "lat": m.lat}, "kind": "gesetzt"})
    if len(pairs) == 1:
        warnings.append(MarkerWarning(code="geo_single", page=fit_page + 1))
        pairs = []

    declared = len({f.index for f in floors})
    try:
        validate_floors(floors, page_count)
    except FloorError as e:
        warnings.append(MarkerWarning(code="pack_invalid", detail=str(e)))
        return MarkerPlan([], fit_page, page_count, pairs, warnings, reference_index, declared)
    return MarkerPlan(floors, fit_page, page_count, pairs, warnings, reference_index, declared)


# ---------------------------------------------------------------------------------------
# carrying the admin's own edits across a re-export
# ---------------------------------------------------------------------------------------


def marker_snapshot(floor: PlanFloor, version: int) -> dict:
    """What the markers gave for this floor — stored beside it, so a later revision can tell
    the admin's own name/region/join from the one the previous export proposed."""
    return {"version": version, "name": floor.name, "clip": floor.clip, "join": floor.join}


def admin_overrides(floors: list[PlanFloor]) -> dict[tuple[int, int], dict]:
    """Per DRAWING – storey index and part – what a human changed away from that revision's
    marker proposal.

    A floor with no snapshot was never proposed by markers — the admin built it — so every
    field it carries is an override. That is the same comparison, with an empty proposal.
    """
    out: dict[tuple[int, int], dict] = {}
    for f in floors:
        proposed = f.marker or {}
        delta = {k: v for k, v in (("name", f.name), ("clip", f.clip), ("join", f.join)) if v != proposed.get(k)}
        if delta:
            out[f.key] = delta
    return out


def apply_overrides(floors: list[PlanFloor], overrides: dict[tuple[int, int], dict]) -> list[PlanFloor]:
    """The marker plan with the admin's edits laid back on top, keyed by storey index and part.

    So the marker wins wherever it MOVED and the admin had not touched that field, and the
    admin wins wherever they had. A drawing the new export no longer marks takes its override
    with it: structure is the export's to state, corrections are the admin's.
    """
    out = []
    for f in floors:
        delta = overrides.get(f.key, {})
        out.append(
            replace(f, name=delta.get("name", f.name), clip=delta.get("clip", f.clip), join=delta.get("join", f.join))
        )
    # a carried-over join may point at a drawing this export dropped – then it is not a join
    keys = {f.key for f in out}
    return [
        replace(f, join=None) if f.join and (f.join.get("to"), f.join.get("part", 0)) not in keys - {f.key} else f
        for f in out
    ]


# ---------------------------------------------------------------------------------------
# a warning, said out loud
# ---------------------------------------------------------------------------------------

#: One German sentence per code, for the CLI (`just plan-markers`) and the worker's log. The
#: ADMIN UI does not read these — it renders the same codes through
#: `admin.alignment.markerWarnings.<code>`, so the page speaks the operator's own language. Keep
#: the two in step: a new code needs a line here and a key there.
_SAID: dict[str, str] = {
    "unknown_tag": "«{tag}» auf Seite {page}: kein Marker, den dieses System kennt – Tippfehler?",
    "page_rotated": "Eine markierte Seite ist im PDF gedreht – ihre Positionen werden im ungedrehten Blatt gelesen.",
    "duplicate_storey": "Ebene {storey} · Punkt {label}: zweimal markiert (Seite {page}) – die erste zählt.",
    "storey_page_split": "Ebene {storey} · Punkt {label}: Marker auf Seite {page}, die Zeichnung auf Seite {other} – ignoriert.",
    "no_level_zero": "Kein §EG / §0 – die Ausrichtungsseite wird aus den markierten Ebenen geraten.",
    "no_shared_join": "Ebene {storey}: kein gemeinsamer Verbindungspunkt mit den übrigen Geschossen.",
    "corner_missing": "{tag}: Ecke {side} fehlt – {have} hat kein Gegenstück; ohne beide gilt die ganze Seite.",
    "corner_stray": "Bereichsecken für Ebene {storey}{point}, die kein §-Marker erklärt – ignoriert.",
    "part_without_join": "{tag}: {nth} Zeichnung ohne Verbindungspunkt ({want} fehlt).",
    "region_off_page": "{tag} (Seite {page}): eine Ecke liegt ausserhalb der Seite ({axis} {value}) – Bereich ignoriert.",
    "region_page_split": "Ebene {storey}: die Bereichsecken liegen nicht auf der Seite der Zeichnung – Bereich ignoriert.",
    "join_outside_region": "{tag} (Seite {page}): der Verbindungspunkt liegt ausserhalb des Bereichs, den die Ecken dieser Ebene angeben – Ecken prüfen.",
    "geo_off_fit_page": "{count} §GEO liegen nicht auf der Ausrichtungsseite (Seite {page}) – ignoriert; ein Pack hat EINE Passung.",
    "geo_duplicate": "{tag} (Seite {page}): derselbe Punkt ist bereits gepaart – ignoriert.",
    "geo_single": "Kartenfit: nur ein §GEO auf der Ausrichtungsseite (Seite {page}) – zwei sind nötig, also wird keine Passung vorgeschlagen.",
    "pack_invalid": "Die markierten Geschosse ergeben kein gültiges Geschoss-Pack ({detail}) – es wird keines vorgeschlagen.",
}
_SIDE = {"tl": "oben links", "br": "unten rechts"}
#: «die zweite Zeichnung» reads as German; «Zeichnung 2» reads as a database
_NTH = ("erste", "zweite", "dritte", "vierte", "fünfte", "sechste")


def text(warning: MarkerWarning) -> str:
    """One warning as the German sentence the CLI prints and the log records.

    An unknown code prints itself rather than raising: this renders diagnostics, and a diagnostic
    that crashes the dry run is worse than one that reads a little raw.
    """
    said = _SAID.get(warning["code"])
    if said is None:
        return warning["code"]
    fields: dict[str, object] = dict(warning)
    if "storey" in warning:
        fields["storey"] = f"{warning['storey']:+d}"
    # a NAMED region corner says which drawing it was meant to delimit; an unnamed one says «die
    # Ecken dieser Ebene» and nothing more, so the clause is left out rather than filled with «?»
    fields["point"] = f" · Punkt {warning['label']}" if warning.get("label") else ""
    if "side" in warning:
        fields["side"] = _SIDE[warning["side"]]
    # a storey drawn ONCE says nothing about drawings at all – which is every pack but a handful
    part = warning.get("part", 0)
    fields["nth"] = _NTH[part] if part < len(_NTH) else f"{part + 1}."
    return said.format_map(_Blanks(fields))


class _Blanks(dict):
    """A field a template names but the warning does not carry prints «?», never raises."""

    def __missing__(self, key: str) -> str:
        return "?"


# ---------------------------------------------------------------------------------------
# the plan author's dry run
# ---------------------------------------------------------------------------------------


def _level(m: Marker) -> str:
    """The storey a marker names. ``§DG`` only gets an index once the whole sheet is read, and a
    marker printed before that (or one that is no storey at all) must still print."""
    if m.index is not None:
        return f"{m.index:+d}"
    return "DG" if m.dach else "?"


def _says(m: Marker) -> str:
    """The marker's statement in words – what the CLI prints after its coordinates."""
    if m.kind == "geo":
        return f"map point {m.lat:.6f} {m.lng:.6f} (WGS84 lat lon)"
    if m.kind in ("corner_tl", "corner_br"):
        side = "top-left" if m.kind == "corner_tl" else "bottom-right"
        return f"region {side} of storey {_level(m)}" + (f" point «{m.label}»" if m.label else "")
    if m.kind == "floor":
        point = "" if m.label == DEFAULT_LABEL else f" point «{m.label}»"
        return f"storey {_level(m)}{point}" + (f" «{m.name}»" if m.name else "")
    return "NOT UNDERSTOOD"


def report(path: Path) -> str:
    """One line per tag, then the warnings — what `just plan-markers <pdf>` prints."""
    raw, page_count = _read(path.read_bytes())
    # the same resolution the plan runs, so the author reads the storey a «§DG» ENDED UP at
    markers = _resolve_dach(raw)
    lines = [f"{path.name}: {page_count} page(s), {len(markers)} marker(s)"]
    if not markers:
        lines.append("  (no § markers – this PDF prepares nothing by itself)")
    for m in markers:
        lines.append(f"  p{m.page + 1:<3} {m.text:<30} x={m.x:.4f}  y={m.y:.4f}   {m.kind:<9} {_says(m)}")

    plan = plan_from_markers(markers, page_count)
    if plan is None:
        lines.append("\nNo storey marker – no floor pack is proposed.")
        return "\n".join(lines)
    counts = Counter(f.index for f in plan.floors)
    drawn = f" in {len(plan.floors)} drawing(s)" if len(plan.floors) > len(counts) else ""
    lines.append(
        f"\nFloor pack: {len(counts)} storey(s){drawn}, fit page {plan.fit_page + 1}, {len(plan.pairs)} map pair(s)"
    )
    for f in plan.floors:
        region = "whole page" if f.clip is None else "region " + " ".join(f"{v:.4f}" for v in f.clip)
        if f.join is not None:
            join = f"joins {f.join['to']:+d}" + (f"/{f.join['part'] + 1}" if f.join.get("part") else "")
        else:
            join = "reference" if f.index == plan.reference and f.part == 0 else "NOT JOINED"
        # a storey drawn twice reads «+1/2» – the storey, then which of its drawings
        level = f"{f.index:+d}" + (f"/{f.part + 1}" if counts[f.index] > 1 else "")
        lines.append(f"  {level:<5} {f.name or '–':<16} page {f.page + 1:<3} {region:<40} {join}")
    for w in plan.warnings:
        lines.append(f"  ⚠ [{w['code']}] {text(w)}")
    if not plan.warnings:
        lines.append("  no warnings")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="plan-markers",
        description="Read the § markers of a plan PDF and print the floor pack + map fit they propose.",
    )
    parser.add_argument("pdf", type=Path, help="the PDF to read (nothing is written)")
    path = parser.parse_args().pdf
    if not path.is_file():
        sys.exit(f"{path}: no such file")
    print(report(path))


if __name__ == "__main__":
    main()
