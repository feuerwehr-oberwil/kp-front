"""Pure composer tests — no app, no DB, no event loop, so they live outside
``test_report_pdf.py`` and its module-wide ``pytest.mark.asyncio``.

Each one guards a bug that a diff cannot show and only a printer reveals: an empty sheet
between two Anhang sections, a Beilage that claimed a whole page, a roster that crashed the
composer at the page boundary.
"""

import io

import pypdfium2 as pdfium
from PIL import Image

from app.report_pdf import ReportPayload, compose_report_pdf


def test_no_blank_page_between_kroki_and_beilagen():
    """⚠️ Every Anhang section opens with a page break AND closes by switching back, so two
    adjacent ones ejected a sheet carrying nothing but the footer — and a rapport ending on the
    Kroki or the Beilagen ended on one. Invisible in a diff, obvious on the printer."""

    def png(w: int, h: int) -> bytes:
        b = io.BytesIO()
        Image.new("RGB", (w, h), (210, 215, 225)).save(b, "PNG")
        return b.getvalue()

    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Blank-Page-Probe", "id": "p"},
            "generatedAt": "07.08.2026 01:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "krokiKey": "k",
            "attachments": [{"url": "/api/media/a1", "caption": "Ausweis"}],
        }
    )
    pdf = compose_report_pdf(payload, {"k": png(1600, 1000), "photo:/api/media/a1": png(1200, 1600)})

    doc = pdfium.PdfDocument(pdf)
    # a page is "blank" when the only thing on it is the «n / m» footer
    blanks = [i for i in range(len(doc)) if len(doc[i].get_textpage().get_text_range().strip()) < 12]
    assert not blanks, f"blank page(s) at {blanks} of {len(doc)}"


def test_beilagen_plates_share_a_page():
    """Capped plates FLOW — a full-page plate each turned four photos into four sheets."""

    def png() -> bytes:
        b = io.BytesIO()
        Image.new("RGB", (1200, 1600), (200, 210, 200)).save(b, "PNG")
        return b.getvalue()

    urls = [f"/api/media/a{i}" for i in range(4)]
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Beilagen-Probe", "id": "p"},
            "generatedAt": "07.08.2026 01:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "attachments": [{"url": u, "caption": f"Bild {i}"} for i, u in enumerate(urls)],
        }
    )
    pdf = compose_report_pdf(payload, {f"photo:{u}": png() for u in urls})
    # 4 plates: the form page + 2 Beilagen pages, not the form page + 4
    assert len(pdfium.PdfDocument(pdf)) == 3


def test_a_roster_longer_than_a_page_still_composes():
    """⚠️ The two-up columns are sub-tables, and a sub-table cannot split: put both halves in
    ONE outer row and a 120-person roster raises a LayoutError that sinks the whole rapport."""

    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Grosse Wehr", "id": "p"},
            "generatedAt": "07.08.2026 01:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "personal": [
                {"name": f"Person {i:03d}", "erfasst": True, "von": "19:12", "bis": "21:40"} for i in range(120)
            ],
        }
    )
    assert len(pdfium.PdfDocument(compose_report_pdf(payload, {}))) >= 2


def _text(pdf: bytes, page: int = 0) -> str:
    return pdfium.PdfDocument(pdf)[page].get_textpage().get_text_range()


def test_an_uebung_says_so_on_the_paper():
    """An Übung is excluded from the statistics, so a drill rapport that reads like a real
    deployment is a record that contradicts the numbers. Nothing else on the sheet tells them
    apart — the marker rides above the title, before anything else is read."""
    base = {
        "incident": {"title": "Zimmerbrand", "id": "i", "type": "Brand"},
        "generatedAt": "07.08.2026 09:00",
        "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
    }
    real = compose_report_pdf(ReportPayload.model_validate(base), {})
    drill = compose_report_pdf(
        ReportPayload.model_validate({**base, "incident": {**base["incident"], "isExercise": True}}), {}
    )
    assert "ÜBUNG" not in _text(real)
    assert "ÜBUNG" in _text(drill)


def test_the_einsatz_category_is_labelled_as_one():
    """`incident.type` is the wizard's «Kategorie»; the Stichwort is the title above the box.
    The details box called the category «Stichwort», which named the wrong field."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i", "type": "Brand"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
        }
    )
    text = _text(compose_report_pdf(payload, {}))
    assert "Kategorie" in text
    assert "Brand" in text
