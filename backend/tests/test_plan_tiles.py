"""The plan tile pyramid (app/plan_tiles): geometry, seam-free blocks, the API and the fill."""

from io import BytesIO
from itertools import pairwise

import pytest
from PIL import Image, ImageChops
from reportlab.pdfgen.canvas import Canvas

from app import plan_tiles, storage

A4 = (595.0, 842.0)


def _pdf(size=A4, pages: int = 1, rotate: int = 0) -> bytes:
    """A page with a diagonal, a frame and a word – something every block has ink from."""
    buf = BytesIO()
    canvas = Canvas(buf, pagesize=size)
    for _ in range(pages):
        if rotate:
            canvas.setPageRotation(rotate)
        w, h = size
        canvas.setLineWidth(3)
        canvas.rect(20, 20, w - 40, h - 40)
        canvas.line(0, 0, w, h)
        canvas.setFont("Helvetica", 40)
        canvas.drawString(60, h - 90, "OBEN LINKS")
        canvas.showPage()
    canvas.save()
    return buf.getvalue()


@pytest.fixture
def stored(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    plan_tiles._settled.clear()

    def put(data: bytes, name: str = "plans/x/one.pdf") -> str:
        storage.put_bytes(name, data)
        return name

    return put


def test_the_top_level_is_600_dpi_and_the_pyramid_halves_down_to_one_tile():
    levels = plan_tiles.levels_for(1683.84, 2384.16)  # the Gymnasium's A1
    assert [(lv.width, lv.height) for lv in levels][-1] == (14032, 19868)
    assert levels[0].cols == levels[0].rows == 1
    for small, big in pairwise(levels):
        assert abs(big.width - 2 * small.width) <= 1 and big.z == small.z + 1


def test_a_sheet_too_large_for_600_dpi_is_capped_rather_than_refused():
    levels = plan_tiles.levels_for(72 * 100, 72 * 20)  # a 2.5 m banner
    assert max(levels[-1].width, levels[-1].height) == plan_tiles.MAX_LEVEL_SIDE


def _mosaic(key: str, page: int, z: int) -> Image.Image:
    level = plan_tiles._level(plan_tiles.manifest(key), page, z)
    out = Image.new("RGB", (level.width, level.height), "red")
    for y in range(level.rows):
        for x in range(level.cols):
            with Image.open(BytesIO(storage.get_bytes(plan_tiles.tile_key(key, page, z, x, y)))) as tile:
                out.paste(tile.convert("RGB"), (x * plan_tiles.TILE, y * plan_tiles.TILE))
    return out


def _whole(key: str, page: int, width: int, height: int) -> Image.Image:
    import pypdfium2 as pdfium

    with plan_tiles.pdfium_lock:
        document = pdfium.PdfDocument(storage.local_path(key))
        pdf_page = document[page]
        w_pt, _ = pdf_page.get_size()
        image = pdf_page.render(scale=width / w_pt).to_pil().convert("RGB")
        pdf_page.close()
        document.close()
    return image.resize((width, height)) if image.size != (width, height) else image


@pytest.mark.parametrize("rotate", [0, 90])
def test_blocks_meet_without_a_seam_and_in_the_frame_the_page_is_shown_in(stored, rotate):
    """The tiles of a level, laid side by side, ARE the page rendered whole – across block
    borders too, and for a page carrying /Rotate (tiles live in the displayed frame)."""
    key = stored(_pdf(rotate=rotate))
    assert plan_tiles.fill(key, batches=99)
    doc = plan_tiles.manifest(key)
    assert doc["complete"] is True
    z = 3  # 2480 × 3508: two blocks wide, two high
    level = plan_tiles._level(doc, 0, z)
    # (ReportLab swaps the MediaBox under a /Rotate, so the DISPLAYED page stays portrait – the
    # fixture is a turned page that must still come out upright, which the comparison proves)
    assert level.cols > plan_tiles.BLOCK or level.rows > plan_tiles.BLOCK
    diff = ImageChops.difference(_mosaic(key, 0, z), _whole(key, 0, level.width, level.height))
    # lossless tiles of the same PDFium render: identical but for sub-pixel scale rounding
    assert diff.convert("L").point(lambda v: 255 if v > 96 else 0).getbbox() is None


def test_a_cold_tile_is_rendered_on_demand_with_its_block(stored):
    key = stored(_pdf())
    top = plan_tiles.manifest(key)["pages"][0]["levels"][-1]
    assert not plan_tiles.is_complete(key)
    asked = plan_tiles.tile(key, 0, top["z"], 1, 1)
    assert storage.exists(asked)
    # …and its neighbours in the same block came with it
    assert storage.exists(plan_tiles.tile_key(key, 0, top["z"], 3, 3))
    with pytest.raises(plan_tiles.TileError):
        plan_tiles.tile(key, 0, top["z"], top["cols"], 0)
    with pytest.raises(plan_tiles.TileError):
        plan_tiles.tile(key, 0, 99, 0, 0)


def test_the_fill_works_small_levels_first_and_says_when_it_is_done(stored):
    key = stored(_pdf(pages=2))
    first = plan_tiles.missing_blocks(key)
    assert first[0][1] == 0 and first[-1][1] == max(b[1] for b in first)
    assert {b[0] for b in first} == {0, 1}
    assert plan_tiles.fill(key, batches=1) is False
    assert len(plan_tiles.missing_blocks(key)) < len(first)
    assert plan_tiles.fill(key, batches=99) is True and plan_tiles.missing_blocks(key) == []


def test_a_long_reader_document_gets_no_pyramid(stored):
    key = stored(_pdf(pages=plan_tiles.MAX_PAGES + 1))
    with pytest.raises(plan_tiles.TileError):
        plan_tiles.manifest(key)


def test_tiles_are_derived_and_stay_out_of_the_backup(stored, tmp_path):
    from app.backup import pin_blobs

    key = stored(_pdf())
    plan_tiles.tile(key, 0, 0, 0, 0)
    pin_blobs(tmp_path / ".pinned")
    assert (tmp_path / ".pinned" / key).is_file()
    assert not (tmp_path / ".pinned" / plan_tiles.ROOT).exists()


@pytest.mark.asyncio
async def test_the_api_serves_a_manifest_and_immutable_tiles_for_a_pinned_revision(
    client, session_factory, admin_login, tmp_path, monkeypatch
):
    from app.models import ObjectSite
    from app.plans import store_plan

    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    plan_tiles._settled.clear()
    async with session_factory() as db:
        obj = ObjectSite(name="Gymnasium", address="Allschwilerstrasse 100")
        db.add(obj)
        await db.flush()
        dataset = await store_plan(db, obj, "modul6", _pdf())
        dataset_id = dataset.id
        await db.commit()
    await admin_login(client)

    r = await client.get(f"/api/reference/{dataset_id}/tiles", params={"v": 1})
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["tileSize"] == 512 and doc["complete"] is False and doc["pages"][0]["page"] == 0
    assert "no-cache" in r.headers["cache-control"]

    r = await client.get(f"/api/reference/{dataset_id}/tiles/1/0/0/0/0")
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert "immutable" in r.headers["cache-control"]
    with Image.open(BytesIO(r.content)) as tile:
        assert tile.size == (doc["pages"][0]["levels"][0]["width"], doc["pages"][0]["levels"][0]["height"])

    assert (await client.get(f"/api/reference/{dataset_id}/tiles/1/0/0/5/5")).status_code == 404
    assert (await client.get(f"/api/reference/{dataset_id}/tiles/9/0/0/0/0")).status_code == 404
    assert (await client.get(f"/api/reference/{dataset_id}/tiles", params={"v": 9})).status_code == 404

    # the background fill finishes the same pyramid, then idles
    for _ in range(40):
        if not await plan_tiles.fill_once(session_factory):
            break
    r = await client.get(f"/api/reference/{dataset_id}/tiles", params={"v": 1})
    assert r.json()["complete"] is True
    assert await plan_tiles.fill_once(session_factory) is False
