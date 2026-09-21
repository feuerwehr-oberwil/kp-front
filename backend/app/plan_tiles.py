"""A plan PDF as a TILE PYRAMID, rendered once per revision by PDFium (21.09.2026).

Why this exists: the client used to rasterise every plan itself with pdf.js, and pdf.js walks
the WHOLE page's display list on every render, whatever the size of the canvas. The Gymnasium's
Modul 6 (Allschwilerstrasse 100) is one A1 page of 357 000 paths and 21 000 images: 4.5 s a pass
on a desktop, north of 10 s on a tablet — for the first paint, for every storey of the Gebäude
and again after every pan at depth. And its room stamps are 0.29 mm tall on paper, which needs
~600 dpi to read: a 280 M px raster no tablet can hold, so the pixel budget capped it to mush.

Tiles answer both at once. PDFium draws the same page natively in about a second, a revision's
bytes never change (`plan_revisions`), and a client showing tiles holds a SCREENFUL of pixels
whatever the sheet's size or the zoom. The whole 600 dpi pyramid of that A1 is ~8 MB of lossless
WebP — smaller than the PDF it came from.

Shape:

* Level ``Z`` (the last) is the page at `TOP_DPI`; every level below halves it, down to the one
  whose long side fits a single tile. A level is cut into `TILE`-px squares, ``x`` right and
  ``y`` DOWN from the page's top-left, in the page's DISPLAYED frame (its own /Rotate applied) —
  the frame pdf.js shows, so a tile lies exactly where the client's bitmap used to.
* PDFium renders a BLOCK of `BLOCK` × `BLOCK` tiles per call (2048 px, a 16 MB bitmap), and a
  few blocks per page LOAD (`BATCH`): loading parses the page, which is most of what a dense
  sheet costs, while a whole level per call would allocate hundreds of megabytes on the one
  process that also serves requests.
  The block is drawn through `FPDF_RenderPageBitmap`'s own offset, never a crop in points —
  pixel-exact, so neighbouring blocks meet without a seam.
* Tiles are DERIVED and live under their own root (`plan-tiles/`, keyed by the revision's
  storage key), which `app.backup` skips: they are thousands of small files per sheet, and
  every one can be rendered again. `manifest.json` is written first (it is pure geometry),
  `done` last — the background fill (`fill_once`, driven by the scheduler) walks revisions
  without one. A tile asked for before its block exists is rendered on the spot (`tile`).

Every PDFium object is created, used and closed under `pdfium_lock`, per BATCH — so a request
for a Rapport or a Kroki waits a few seconds at most, never for a pyramid.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import logging
import math
import threading
from dataclasses import dataclass
from typing import Any

from . import storage
from .pdfium_lock import pdfium_lock

logger = logging.getLogger(__name__)

#: One tile's side in px. 512 keeps a tablet screen at ~20 tiles and a tile at a few KB.
TILE = 512
#: Tiles per block side – what ONE PDFium call draws (2048 px → a 16 MB BGRx bitmap).
BLOCK = 4
#: The top level's resolution. 0.29 mm room stamps need about this to be read comfortably.
TOP_DPI = 600
#: …lowered for a sheet so large that 600 dpi would pass this many px on its long side (an A0
#: is 28 087 — it fits; a plotted banner does not, and is simply served a little softer).
MAX_LEVEL_SIDE = 32_768
#: Past this many pages nothing is tiled at all: a bound Referenz-PDF of hundreds of pages is for
#: the reader (components/PdfScroller keeps pdf.js), and its manifest alone would be megabytes.
MAX_PAGES = 80
#: …and the BACKGROUND fill only walks documents up to this size on its own – except a floor pack
#: (`modul6`), which is one Geschoss per page however many storeys there are. ⚠️ 21.09.2026: one
#: limit for both refused Langegasse 97a's 29-page Modul 6 a pyramid altogether, i.e. exactly the
#: sheets the Gebäude draws its storeys from. A long PV/RWA document is still not rendered ahead
#: of time (39 pages at 600 dpi is ten minutes of PDFium nobody asked for); a page of it that IS
#: opened on the board renders on demand like any cold tile.
FILL_MAX_PAGES = 12
FILL_ALWAYS_MODULES = ("modul6",)
#: A lossless tile heavier than this is a scan or a photo; lossy WebP is then a fifth of it.
LOSSLESS_LIMIT = 96 * 1024
ROOT = "plan-tiles"
FORMAT_VERSION = 1


class TileError(ValueError):
    """The request names something this pyramid does not have (→ 404), or the PDF cannot give
    one (`unsupported`, → the client keeps its pdf.js path)."""


@dataclass(frozen=True, slots=True)
class Level:
    z: int
    width: int
    height: int

    @property
    def cols(self) -> int:
        return math.ceil(self.width / TILE)

    @property
    def rows(self) -> int:
        return math.ceil(self.height / TILE)


def levels_for(width_pt: float, height_pt: float) -> list[Level]:
    """The pyramid of one page, smallest level first. Pure – the geometry the manifest states,
    the renderer draws and the client lays out must be this one function's."""
    if not (math.isfinite(width_pt) and math.isfinite(height_pt) and width_pt > 0 and height_pt > 0):
        raise TileError("invalid_page_size")
    long_pt = max(width_pt, height_pt)
    top = min(TOP_DPI / 72, MAX_LEVEL_SIDE / long_pt)
    count = max(0, math.ceil(math.log2(max(1.0, long_pt * top / TILE)))) + 1
    out = []
    for z in range(count):
        k = top / 2 ** (count - 1 - z)
        out.append(Level(z, max(1, round(width_pt * k)), max(1, round(height_pt * k))))
    return out


def prefix(storage_key: str) -> str:
    """Where one revision's tiles live. The revision's storage key is fresh per byte version
    (`plans.store_plan`), so hashing it keys the pyramid by exactly the bytes it was drawn from."""
    return f"{ROOT}/{hashlib.sha256(storage_key.encode()).hexdigest()[:32]}"


def tile_key(storage_key: str, page: int, z: int, x: int, y: int) -> str:
    return f"{prefix(storage_key)}/p{page}/{z}/{x}-{y}.webp"


def _open(storage_key: str) -> Any:
    import pypdfium2 as pdfium

    return pdfium.PdfDocument(storage.local_path(storage_key))


def manifest(storage_key: str) -> dict:
    """The pyramid's geometry, read from the PDF once and kept beside the tiles. `complete` is
    live: it says whether the fill has finished, i.e. whether a prefetch will be served from
    disk or would make the server render the whole sheet on the spot."""
    key = f"{prefix(storage_key)}/manifest.json"
    if storage.exists(key):
        doc = json.loads(storage.get_bytes(key))
        if doc.get("version") == FORMAT_VERSION:
            return {**doc, "complete": is_complete(storage_key)}
    with pdfium_lock:
        document = _open(storage_key)
        try:
            count = len(document)
            if count > MAX_PAGES:
                raise TileError("unsupported")
            pages = []
            for index in range(count):
                page = document[index]
                try:
                    width_pt, height_pt = page.get_size()
                finally:
                    page.close()
                pages.append(
                    {
                        "page": index,
                        "widthPt": width_pt,
                        "heightPt": height_pt,
                        "levels": [
                            {"z": lv.z, "width": lv.width, "height": lv.height, "cols": lv.cols, "rows": lv.rows}
                            for lv in levels_for(width_pt, height_pt)
                        ],
                    }
                )
        finally:
            document.close()
    doc = {"version": FORMAT_VERSION, "tileSize": TILE, "format": "webp", "pages": pages}
    storage.put_bytes(key, json.dumps(doc, separators=(",", ":")).encode())
    return {**doc, "complete": is_complete(storage_key)}


def is_complete(storage_key: str) -> bool:
    return storage.exists(f"{prefix(storage_key)}/done")


def _level(doc: dict, page: int, z: int) -> Level:
    entry = next((p for p in doc["pages"] if p["page"] == page), None)
    found = next((lv for lv in entry["levels"] if lv["z"] == z), None) if entry else None
    if found is None:
        raise TileError("not_found")
    return Level(found["z"], found["width"], found["height"])


def _encode(image: Any) -> bytes:
    """Lossless where it is cheap — line art is, and a hairline survives it — and lossy where a
    scan would otherwise cost a megabyte a tile."""
    buf = io.BytesIO()
    image.save(buf, format="WEBP", lossless=True, method=3)
    if buf.tell() > LOSSLESS_LIMIT:
        lossy = io.BytesIO()
        image.save(lossy, format="WEBP", quality=82, method=3)
        if lossy.tell() < buf.tell():
            return lossy.getvalue()
    return buf.getvalue()


#: Blocks drawn per page load. Loading a page PARSES it (0.9 s and ~200 MB for the Gymnasium's
#: A1) while a block then draws and encodes in 0.4 s, so the load must not be paid per block —
#: and six blocks are ~3 s under the PDFium lock, which is as long as a Rapport should wait.
BATCH = 6


def render_blocks(storage_key: str, page: int, blocks: list[tuple[int, int, int]]) -> int:
    """Draw (z, bx, by) blocks of ONE page and store their tiles; returns how many tiles were
    written. Synchronous and PDFium-bound: call it from a worker thread, never the event loop.

    The page is loaded once for the whole batch. ⚠️ Each block is encoded and stored BEFORE the
    next is drawn, inside the lock: holding the batch's images to encode them afterwards cost
    ~150 MB on top of what PDFium's parsed page already takes, on the process that serves
    every request. A caller waiting for PDFium waits a second longer; nobody is killed.
    """
    import pypdfium2 as pdfium
    import pypdfium2.raw as raw

    doc = manifest(storage_key)
    written = 0
    with pdfium_lock:
        document = _open(storage_key)
        try:
            pdf_page = document[page]
            try:
                for z, bx, by in blocks:
                    level = _level(doc, page, z)
                    x0, y0 = bx * BLOCK * TILE, by * BLOCK * TILE
                    if bx < 0 or by < 0 or x0 >= level.width or y0 >= level.height:
                        raise TileError("not_found")
                    width, height = min(BLOCK * TILE, level.width - x0), min(BLOCK * TILE, level.height - y0)
                    bitmap = pdfium.PdfBitmap.new_native(width, height, raw.FPDFBitmap_BGRx)
                    try:
                        bitmap.fill_rect((255, 255, 255, 255), 0, 0, width, height)
                        # the WHOLE level is the render target and the bitmap a window onto it:
                        # pixel-exact offsets, so blocks meet without a seam (a crop in points
                        # rounds). Rotation 0 = the page's own /Rotate, the frame pdf.js shows.
                        raw.FPDF_RenderPageBitmap(
                            bitmap.raw, pdf_page.raw, -x0, -y0, level.width, level.height, 0, raw.FPDF_ANNOT
                        )
                        image = bitmap.to_pil().convert("RGB")
                    finally:
                        bitmap.close()
                    try:
                        for ty in range(0, height, TILE):
                            for tx in range(0, width, TILE):
                                with image.crop((tx, ty, min(tx + TILE, width), min(ty + TILE, height))) as cut:
                                    data = _encode(cut)
                                key = tile_key(storage_key, page, z, (x0 + tx) // TILE, (y0 + ty) // TILE)
                                storage.put_bytes(key, data)
                                written += 1
                    finally:
                        image.close()
            finally:
                pdf_page.close()
        finally:
            document.close()
    _trim()
    return written


def _trim() -> None:
    """Hand freed memory back to the OS. glibc keeps what PDFium's parsed page released (the
    process stayed at 290 MB after closing a 15 MB PDF); on a small container that is the
    difference between a quiet fill and an OOM kill an hour later. A no-op off glibc."""
    with contextlib.suppress(Exception):
        import ctypes

        ctypes.CDLL("libc.so.6").malloc_trim(0)


_block_locks: dict[str, threading.Lock] = {}
_block_locks_guard = threading.Lock()


def tile(storage_key: str, page: int, z: int, x: int, y: int) -> str:
    """The storage key of one tile, rendering its block first when it is not there yet. Two
    requests for one cold block render it once: the second waits and finds the tile."""
    key = tile_key(storage_key, page, z, x, y)
    if storage.exists(key):
        return key
    level = _level(manifest(storage_key), page, z)
    if not (0 <= x < level.cols and 0 <= y < level.rows):
        raise TileError("not_found")
    bx, by = x // BLOCK, y // BLOCK
    name = f"{prefix(storage_key)}/{page}/{z}/{bx}/{by}"
    with _block_locks_guard:
        lock = _block_locks.setdefault(name, threading.Lock())
    try:
        with lock:
            if not storage.exists(key):
                render_blocks(storage_key, page, [(z, bx, by)])
    finally:
        with _block_locks_guard:
            _block_locks.pop(name, None)
    return key


def missing_blocks(storage_key: str) -> list[tuple[int, int, int, int]]:
    """Every (page, z, bx, by) whose first tile is not on disk — small levels first, so a
    half-filled pyramid already serves every fitted view."""
    doc = manifest(storage_key)
    out = []
    for entry in doc["pages"]:
        for lv in entry["levels"]:
            level = Level(lv["z"], lv["width"], lv["height"])
            for by in range(math.ceil(level.rows / BLOCK)):
                for bx in range(math.ceil(level.cols / BLOCK)):
                    if not storage.exists(tile_key(storage_key, entry["page"], level.z, bx * BLOCK, by * BLOCK)):
                        out.append((entry["page"], level.z, bx, by))
    return sorted(out, key=lambda b: (b[1], b[0], b[3], b[2]))


def fill(storage_key: str, batches: int = 1) -> bool:
    """Render up to `batches` batches of missing blocks; True once the pyramid is complete."""
    todo = missing_blocks(storage_key)
    for _ in range(batches):
        if not todo:
            break
        page = todo[0][0]
        batch = [b for b in todo if b[0] == page][:BATCH]
        render_blocks(storage_key, page, [(z, bx, by) for _, z, bx, by in batch])
        todo = [b for b in todo if b not in batch]
    if not todo:
        storage.put_bytes(f"{prefix(storage_key)}/done", b"1")
        return True
    return False


def mark_unsupported(storage_key: str) -> None:
    """A PDF PDFium cannot open is not retried every tick. ⚠️ `unreadable`, not the `unsupported`
    the first release wrote: that one was also set for a document merely past the old page limit,
    and those must be asked again."""
    with contextlib.suppress(OSError):
        storage.put_bytes(f"{prefix(storage_key)}/unreadable", b"1")


def is_unsupported(storage_key: str) -> bool:
    return storage.exists(f"{prefix(storage_key)}/unreadable")


# ---------------------------------------------------------------------------------------
# the background fill
# ---------------------------------------------------------------------------------------

#: Batches per scheduler tick: ~6 s of PDFium, then everyone else gets a turn at the lock.
FILL_BATCHES_PER_TICK = 2
#: Storage keys this process has seen complete (or refused) – spares a stat per revision per tick.
_settled: set[str] = set()


async def fill_once(factory: Any = None) -> bool:
    """One scheduler tick: advance the pyramid of ONE current plan revision that has none yet.
    True when something was rendered. Older revisions a running Einsatz still pins are not
    walked here – the tile endpoint renders them on demand, and they are rare."""
    import anyio
    from sqlalchemy import select

    from .database import async_session_maker
    from .models import PlanRevision, ReferenceDataset

    async with (factory or async_session_maker)() as db:
        rows = (
            await db.execute(
                select(PlanRevision.storage_key, ReferenceDataset.module)
                .join(
                    ReferenceDataset,
                    (ReferenceDataset.id == PlanRevision.dataset_id)
                    & (ReferenceDataset.current_version == PlanRevision.version),
                )
                .where(PlanRevision.content_type.like("%pdf%"))
                .order_by(PlanRevision.created_at.desc())
            )
        ).all()
    for key, module in rows:
        if key in _settled:
            continue
        if is_complete(key) or is_unsupported(key) or not storage.exists(key):
            _settled.add(key)
            continue
        try:
            # by design, not a fault: a long document that is not a floor pack is left to the
            # on-demand path (and one past MAX_PAGES has no pyramid at all)
            pages = len((await anyio.to_thread.run_sync(manifest, key))["pages"])
            if pages > FILL_MAX_PAGES and module not in FILL_ALWAYS_MODULES:
                _settled.add(key)
                continue
        except TileError:
            _settled.add(key)
            continue
        except Exception:
            logger.exception("Plan tiles: %s cannot be read – this revision keeps the pdf.js path", key)
            mark_unsupported(key)
            _settled.add(key)
            continue
        try:
            if await anyio.to_thread.run_sync(fill, key, FILL_BATCHES_PER_TICK):
                _settled.add(key)
                logger.info("Plan tiles complete for %s", key)
        except Exception:
            logger.exception("Plan tiles failed for %s – this revision keeps the pdf.js path", key)
            mark_unsupported(key)
            _settled.add(key)
        return True
    return False
