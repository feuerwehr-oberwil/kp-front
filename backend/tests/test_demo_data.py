"""The public demo alarm and its synthetic object plan stay one coherent story."""

import json
from pathlib import Path

import pypdfium2 as pdfium

from app.admin_objects import _read_manifest, _validate_files
from app.demo_reset import DEMO_ALARM, DEMO_INCIDENT

ROOT = Path(__file__).resolve().parents[2]
DEMO_DIR = ROOT / "examples" / "demo-data"
MANIFEST = DEMO_DIR / "objects.manifest.json"


def test_demo_incident_matches_its_only_object_plan() -> None:
    raw = json.loads(MANIFEST.read_text())
    assert len(raw["objects"]) == 1

    # the pre-filled RUNNING incident is the Schloss, so its object's Module plans attach.
    obj = raw["objects"][0]
    assert obj["name"] == "Schloss Musterdorf"
    assert obj["address"] == DEMO_INCIDENT["address"]
    assert obj["lat"] == DEMO_INCIDENT["lat"]
    assert obj["lng"] == DEMO_INCIDENT["lng"]
    assert [plan["module"] for plan in obj["plans"]] == ["modul1", "modul2-3", "modul6"]

    # the still-pending alarm is a DIFFERENT incident (shows the take-flow next to the running
    # one), so it must NOT sit on the Schloss object.
    assert DEMO_ALARM["address"] != DEMO_INCIDENT["address"]


def test_demo_object_manifest_and_pdfs_are_valid() -> None:
    objects = _read_manifest(MANIFEST)
    assert _validate_files(MANIFEST, objects) == 3

    expected_pages = {"modul1": 1, "modul2-3": 1, "modul6": 3}
    for plan in objects[0].plans:
        path = MANIFEST.parent / plan.file
        assert path.read_bytes().startswith(b"%PDF-")
        pdf = pdfium.PdfDocument(path)
        try:
            assert len(pdf) == expected_pages[plan.module]
            first_page_text = pdf[0].get_textpage().get_text_range()
            assert "Schloss Musterdorf" in first_page_text
            assert "synthetisch" in first_page_text
        finally:
            pdf.close()
