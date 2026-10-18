"""The demo's Tafel opens with pages filled in, and they tell the incident's story at the reset's
clock — never the scene file's frozen one."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import app.demo_reset as dr
from app.board_templates import TemplatePage
from app.demo_reset import build_demo_workspace

ROOT = Path(__file__).resolve().parents[2]
SCENE = ROOT / "examples" / "demo-data" / "incident.workspace.json"
BUNDLED = ROOT / "src" / "data" / "boardTemplates" / "fks-erste-fuehrung.json"
NOW = datetime(2026, 7, 19, 12, 0, 7, tzinfo=UTC)
ZURICH = ZoneInfo("Europe/Zurich")


def _built() -> dict:
    scene = json.loads(SCENE.read_text(encoding="utf-8"))
    present = [(f"pid-{i}", n) for i, n in enumerate(sorted(dr.DEMO_PRESENT))]
    return build_demo_workspace(scene, present, NOW)


def _pages(ws: dict) -> list[dict]:
    return [a for a in ws["board"]["tafel"] if a.get("kind") == "form"]


def test_the_demo_tafel_has_its_pages_next_to_the_gebaeude_chip() -> None:
    ws = _built()
    assert ws["board"]["gebaeude"], "the Trupp chip on the floor stack must stay"
    pages = _pages(ws)
    assert [p["form"]["page"]["id"] for p in pages] == ["ef", "rapport"]
    # the strip orders pages by `at`; both were added during the incident, the Erste Führung first
    ats = [datetime.fromisoformat(p["form"]["at"]) for p in pages]
    assert NOW - timedelta(minutes=dr.DEMO_ELAPSED_MIN) < ats[0] < ats[1] < NOW


def test_the_demo_opens_its_tafel_on_the_filled_erste_fuehrung() -> None:
    """On the demo, a device that has not picked a Tafel page yet opens the FIRST page in the
    strip (lib/tafelPages · fallback, Whiteboard · isDemoMode) instead of the Skizze, which the
    scene leaves empty. So the first page by `at` must be the one with the story on it."""
    ws = _built()
    assert not [a for a in ws["board"]["tafel"] if a.get("kind") != "form"], "the Skizze is empty in the scene"
    first = min(_pages(ws), key=lambda p: p["form"]["at"])
    assert first["form"]["page"]["id"] == "ef"
    assert len(first["form"]["values"]) >= 3, "the page the demo opens on must be filled in"


def test_every_written_value_lands_in_a_box_the_page_has() -> None:
    """⚠️ Values are keyed by ids of the page's own snapshot. A key the snapshot does not have is
    not an error anywhere — the value is simply never drawn, and the demo quietly shows a gap."""
    bundled = {p["id"]: p for p in json.loads(BUNDLED.read_text(encoding="utf-8"))["pages"]}
    tpl = json.loads(BUNDLED.read_text(encoding="utf-8"))
    for anno in _pages(_built()):
        form = anno["form"]
        assert form["v"] == 1
        assert (form["tpl"]["id"], form["tpl"]["version"]) == (tpl["id"], tpl["version"])
        page = TemplatePage.model_validate(form["page"])  # the snapshot passes the contract
        assert form["page"] == bundled[page.id], "the snapshot should be the bundled page as it is"
        sections = {s["id"]: s for s in form["page"]["sections"]}
        for sid, value in form["values"].items():
            sec = sections[sid]
            for box, lines in (value.get("lines") or {}).items():
                assert box in {c["id"] for c in sec["cells"]}, f"{sid}: no box «{box}»"
                assert all(ln["text"].strip() and ln.get("trend") in {None, "up", "same", "down"} for ln in lines)
            fixed = {r["id"] for r in sec.get("fixedRows", [])}
            cols = {c["id"] for c in sec.get("columns", []) if not c.get("fixed")}
            for row in value.get("rows") or []:
                assert set(row["cells"]) <= cols, f"{sid}/{row['id']}: a cell in a column it does not have"
                assert row["id"] in fixed or row.get("ord"), f"{sid}/{row['id']}: a written row needs its order key"
            for field in value.get("fields") or {}:
                assert field in {f["id"] for f in sec["fields"]}, f"{sid}: no field «{field}»"


def test_every_clock_on_the_tafel_reads_the_resets_time() -> None:
    """The scene file stores the «Wann» cells frozen; a row the reset does not re-stamp would show
    a time hours away from the Verlauf beside it."""
    for anno in _pages(_built()):
        form = anno["form"]
        sections = {s["id"]: s for s in form["page"]["sections"]}
        for sid, value in form["values"].items():
            times = [c["id"] for c in sections[sid].get("columns", []) if c.get("type") == "time"]
            for row in value.get("rows") or []:
                for col in times:
                    if col not in row["cells"]:
                        continue
                    assert row["id"] in dr.DEMO_TAFEL_MINUTES, f"{row['id']} keeps the scene file's frozen time"
                    want = (NOW - timedelta(minutes=dr.DEMO_TAFEL_MINUTES[row["id"]])).astimezone(ZURICH)
                    assert row["cells"][col] == want.strftime("%H:%M")
    rapport = next(a["form"] for a in _pages(_built()) if a["form"]["page"]["id"] == "rapport")
    nxt = rapport["values"]["naechster-rapport"]["fields"]
    # 12:00:07 UTC = 14:00 in Zurich (summer), +10 min → the next quarter hour
    assert (nxt["datum"], nxt["zeit"]) == ("19.07.2026", "14:15")


def test_the_demo_mtf_has_no_vor_ort_time_on_the_tafel_either() -> None:
    """The Zeiten grid leaves the MTF without «vor Ort»; the Tafel's Mittel must not contradict it."""
    ef = next(a["form"] for a in _pages(_built()) if a["form"]["page"]["id"] == "ef")
    mtf = next(r for r in ef["values"]["mittel"]["rows"] if r["cells"].get("formation") == "MTF")
    assert "wann" not in mtf["cells"]
    assert not any(f.get("id") == "mtf" and f.get("vorOrt") for f in _built()["reportMeta"]["fahrzeuge"])
