"""The pre-filled demo incident and its synthetic object plan stay one coherent story."""

import json
from pathlib import Path

import pypdfium2 as pdfium

from app.admin_objects import _read_manifest, _validate_files
from app.demo_reset import DEMO_INCIDENT

ROOT = Path(__file__).resolve().parents[2]
DEMO_DIR = ROOT / "examples" / "demo-data"
MANIFEST = DEMO_DIR / "objects.manifest.json"


def test_demo_incident_matches_its_only_object_plan() -> None:
    raw = json.loads(MANIFEST.read_text())
    assert len(raw["objects"]) == 1

    # the pre-filled RUNNING incident is the Schloss, so its object's Module plans attach.
    obj = raw["objects"][0]
    assert obj["name"] == "Schloss Bottmingen"
    assert obj["address"] == DEMO_INCIDENT["address"]
    assert obj["lat"] == DEMO_INCIDENT["lat"]
    assert obj["lng"] == DEMO_INCIDENT["lng"]
    assert [plan["module"] for plan in obj["plans"]] == ["modul1", "modul2-3"]


def test_demo_object_manifest_and_pdfs_are_valid() -> None:
    objects = _read_manifest(MANIFEST)
    assert _validate_files(MANIFEST, objects) == 2

    expected_pages = {"modul1": 1, "modul2-3": 1}
    for plan in objects[0].plans:
        path = MANIFEST.parent / plan.file
        assert path.read_bytes().startswith(b"%PDF-")
        pdf = pdfium.PdfDocument(path)
        try:
            assert len(pdf) == expected_pages[plan.module]
            first_page_text = pdf[0].get_textpage().get_text_range()
            # Every demo sheet has to SAY on its face that it is demo material — a plan that
            # looks like a real Einsatzplan and is not marked as one gets screenshotted, or
            # forked into a station's own data. Both remaining sheets are hand-drawn and say it
            # through Musterdorf and their own content («Hinter den 7 Bergen», Sofortmassnahme
            # «Prinzessin befreien»); the «synthetisch» stamp is what a generated sheet uses.
            assert "synthetisch" in first_page_text or "Musterdorf" in first_page_text
        finally:
            pdf.close()
