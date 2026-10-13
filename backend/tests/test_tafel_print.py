"""The Tafel's own print (10.10.2026, owner: «maybe add a print option»): one page or all of
them, the same sheets the Rapport carries, without the Rapport around them."""

from __future__ import annotations

import io
import json

import pypdfium2 as pdfium
import pytest

from app.report_pdf import TafelPrintPayload, compose_tafel_pdf
from tests.test_report_board import _ef


def _pages(pdf: bytes) -> list[tuple[float, float, str]]:
    doc = pdfium.PdfDocument(io.BytesIO(pdf))
    return [(doc[i].get_width(), doc[i].get_height(), doc[i].get_textpage().get_text_range()) for i in range(len(doc))]


def _landscape_text_page() -> dict:
    return {
        "title": "Problemerfassung",
        "landscape": True,
        "columns": 1,
        "sections": [
            {"id": "t", "type": "text", "title": "Konzept", "fields": [{"label": "Auftrag", "value": "Halten"}]}
        ],
    }


def test_one_page_prints_alone_on_its_own_paper():
    pdf = compose_tafel_pdf(
        TafelPrintPayload.model_validate(
            {"incident": {"title": "Brand", "id": "x"}, "generatedAt": "10.10.2026 18:05", "boardPages": [_ef()]}
        )
    )
    pages = _pages(pdf)
    assert len(pages) == 1
    w, h, text = pages[0]
    assert h > w  # the Erste Führung: the poster on A4 portrait
    assert "Erste Führung" in text and "Rettungen Haus 19" in text
    assert "Einsatzjournal" not in text  # the Tafel, not the Rapport


def test_all_pages_each_in_its_template_paper_and_a_landscape_first_sheet_starts_landscape():
    payload = {
        "incident": {"title": "Brand", "id": "x"},
        "generatedAt": "10.10.2026 18:05",
        "boardPages": [_landscape_text_page(), _ef()],
    }
    pages = _pages(compose_tafel_pdf(TafelPrintPayload.model_validate(payload)))
    assert len(pages) == 2
    assert pages[0][0] > pages[0][1] and "Problemerfassung" in pages[0][2]
    assert pages[1][1] > pages[1][0] and "Erste Führung" in pages[1][2]


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_the_endpoint_prints_the_tafel_and_names_the_file_after_it(client, editor):
    await _login(client, editor)
    r = await client.post("/api/incidents", json={"title": "Brand Hauptstrasse 4"})
    inc = r.json()["id"]
    body = {
        "incident": {"title": "Brand Hauptstrasse 4", "id": inc},
        "generatedAt": "10.10.2026 18:05",
        "boardPages": [_ef()],
    }
    r = await client.post(f"/api/incidents/{inc}/tafel/pdf", data={"payload": json.dumps(body)})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert "Tafel_Brand_Hauptstrasse_4.pdf" in r.headers["content-disposition"]
    assert r.content.startswith(b"%PDF")
    empty = await client.post(
        f"/api/incidents/{inc}/tafel/pdf", data={"payload": json.dumps({**body, "boardPages": []})}
    )
    assert empty.status_code == 422
