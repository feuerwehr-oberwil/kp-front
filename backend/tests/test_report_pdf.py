"""Einsatzrapport PDF endpoint: composes a valid PDF from the client payload + figures.

We assert the endpoint returns a real PDF (``%PDF`` magic) for a minimal payload, a full one
with an embedded figure, and that it's robust to edge inputs — visual fidelity is verified by
hand against the print view. Also covers auth (any user, incl. viewer) and the 404/422 paths.
"""

import io
import json

import pytest
from PIL import Image as PILImage

pytestmark = pytest.mark.asyncio


def _png(w: int = 12, h: int = 8) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", (w, h), (200, 210, 220)).save(buf, "PNG")
    return buf.getvalue()


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _create_incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Brand Hauptstrasse 4"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _minimal_payload(inc_id: str) -> dict:
    return {
        "incident": {"title": "Brand Hauptstrasse 4", "id": inc_id},
        "generatedAt": "30.06.2026 03:00",
        "proof": {"statusLabel": "intakt", "count": 12, "head": "abcdef0123456789"},
    }


async def test_report_pdf_minimal(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/report/pdf", data={"payload": json.dumps(_minimal_payload(inc))})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:5] == b"%PDF-"
    assert "attachment" in r.headers.get("content-disposition", "")


async def test_report_pdf_full_with_figures(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    payload = _minimal_payload(inc)
    payload["incident"].update({"type": "Brand", "address": "Hauptstrasse 4", "coords": "47.5, 7.5"})
    payload["meta"] = {
        "summary": "Zimmerbrand im 2. OG, rasch gelöscht.",
        "lehren": "Zugang Hinterhof früher sichern.",
        "verteiler": "Kdt, Gemeinde",
        "einsatzleiter": "M. Muster",
        "eigentuemer": "A. Beispiel",
        "ursache": "Blitzschlag",
        "verursacher": "unbekannt",
        "partnerContacts": [{"org": "Polizei", "name": "Wache", "phone": "117"}],
    }
    payload["options"] = {"kroki": True, "atemschutz": True, "attendance": True, "mittel": True, "journal": True}
    payload["mittel"] = [{"label": "Ölbinder", "menge": "3 Sack", "sources": "TLF"}]
    payload["retablierung"] = [{"label": "Ölbinder", "menge": "3 Sack", "status": "Nachfüllen / ersetzen"}]
    payload["krokiKey"] = "kroki"
    payload["krokiCaption"] = "Stand 03:00"
    payload["plans"] = [{"key": "plan_modul1", "label": "M1 Übersicht", "landscape": False}]
    payload["trupps"] = [
        {
            "name": "AT 1",
            "statusLabel": "im Einsatz",
            "members": ["A", "B"],
            "auftrag": "Löschangriff",
            "entryTime": "03:05",
            "readings": [{"t": "03:05", "kindLabel": "Eintritt", "bar": "300"}],
        }
    ]
    payload["attendance"] = [{"name": "C. Beispiel", "statusLabel": "Anwesend", "checkedInAt": "03:01"}]
    payload["journal"] = [
        {"timeLabel": "03:02", "area": "Kroki", "text": "Erkundung Vorderseite", "transcript": "..."},
        {"timeLabel": "03:08", "area": "M1", "text": "Foto Lage", "photoKey": "photo_e1"},
    ]

    files = [
        ("figures", ("kroki", _png(40, 28), "image/png")),
        ("figures", ("plan_modul1", _png(30, 40), "image/png")),
        ("figures", ("photo_e1", _png(20, 15), "image/png")),
    ]
    r = await client.post(f"/api/incidents/{inc}/report/pdf", data={"payload": json.dumps(payload)}, files=files)
    assert r.status_code == 200, r.text
    assert r.content[:5] == b"%PDF-"
    assert len(r.content) > 1500  # embedded figures + tables → a non-trivial document


async def test_report_pdf_viewer_allowed(client, viewer, editor):
    # a viewer (read-only) may still generate the report — it's read-only output
    await _login(client, editor)
    inc = await _create_incident(client)
    await client.post("/api/auth/logout")
    await _login(client, viewer)
    r = await client.post(f"/api/incidents/{inc}/report/pdf", data={"payload": json.dumps(_minimal_payload(inc))})
    assert r.status_code == 200, r.text
    assert r.content[:5] == b"%PDF-"


async def test_report_pdf_unknown_incident_404(client, editor):
    await _login(client, editor)
    missing = "99999999-9999-9999-9999-999999999999"
    r = await client.post(
        f"/api/incidents/{missing}/report/pdf", data={"payload": json.dumps(_minimal_payload(missing))}
    )
    assert r.status_code == 404


async def test_report_pdf_bad_payload_422(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/report/pdf", data={"payload": "{not json"})
    assert r.status_code == 422


async def test_report_pdf_prints_beilagen_from_the_media_store(client, editor):
    """A Rapport-Beilage (ID document, damage photo) is resolved from the media store and
    printed as its own plate — the same server-side lookup a journal photo uses. A URL that
    resolves to nothing must drop that plate, not the rapport."""
    await _login(client, editor)
    inc = await _create_incident(client)
    up = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("ausweis.png", io.BytesIO(_png(60, 40)), "image/png")},
        data={"kind": "photo"},
    )
    assert up.status_code in (200, 201), up.text
    url = up.json()["url"]

    payload = _minimal_payload(inc)
    payload["attachments"] = [
        {"url": url, "caption": "Ausweis Lenker"},
        {"url": "/api/media/00000000-0000-0000-0000-000000000000"},  # gone → skipped, not fatal
    ]
    r = await client.post(f"/api/incidents/{inc}/report/pdf", data={"payload": json.dumps(payload)})
    assert r.status_code == 200, r.text
    assert r.content[:5] == b"%PDF-"

    # …and the same rapport WITHOUT the Beilage is smaller: the plate really is in there
    bare = await client.post(f"/api/incidents/{inc}/report/pdf", data={"payload": json.dumps(_minimal_payload(inc))})
    assert len(r.content) > len(bare.content)


async def test_report_pdf_survives_a_pasted_essay_in_a_remark(client, editor):
    """A free remark rides in a fixed-width table cell, and ReportLab cannot split a cell
    across pages: a long enough one raised LayoutError and the WHOLE compose 500'd with an
    error naming no field — the rapport simply could not be printed any more.

    Printing must never be blocked by what someone typed, so the remark is truncated. The
    lengths here are past the measured failure points (~3.1k person / ~3.8k Mittel); the
    Mittel one matters most because the client JOINS every source line's remark into one cell.
    """
    await _login(client, editor)
    inc = await _create_incident(client)
    payload = _minimal_payload(inc)
    essay = "Lorem ipsum dolor sit amet, consetetur sadipscing elitr. " * 120  # ~6.7k chars
    payload["personal"] = [{"name": "Meier A.", "erfasst": True, "note": essay}]
    payload["mittelForm"] = [{"label": "Ölbindemittel", "menge": "3", "unit": "Sack", "note": essay}]

    r = await client.post(f"/api/incidents/{inc}/report/pdf", data={"payload": json.dumps(payload)})
    assert r.status_code == 200, r.text
    assert r.content[:5] == b"%PDF-"


async def test_over_long_remarks_are_truncated_not_rejected():
    """Rejecting (422) would only move the failure — the text is already in the workspace and
    the operator has no way to shorten it from the print sheet."""
    from app.report_pdf import _NOTE_MAX, MittelFormRowIn, PersonalRowIn

    long = "x" * (_NOTE_MAX + 500)
    assert len(PersonalRowIn(name="A", note=long).note) == _NOTE_MAX
    assert PersonalRowIn(name="A", note=long).note.endswith("…")
    assert len(MittelFormRowIn(label="L", note=long).note) == _NOTE_MAX
    # a remark that fits is left exactly as typed
    assert PersonalRowIn(name="A", note="Fahrer TLF").note == "Fahrer TLF"
    assert PersonalRowIn(name="A", note=None).note is None
