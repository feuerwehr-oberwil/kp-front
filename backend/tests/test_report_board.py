"""The Tafel's pages in the Rapport (10.10.2026, app/report_board): every board-template page
prints as its paper, nothing written is cut off, and an older client prints what it always did."""

from __future__ import annotations

import io

import pypdfium2 as pdfium
import pytest
from reportlab.lib.units import mm

from app.report_board import fit_size, wrap
from app.report_pdf import ReportPayload, compose_report_pdf

SHY = "­"


def _ef(massnahmen_rows: int = 2) -> dict:
    """The Erste Führung as the client resolves it (lib/boardForm · formForPdf), abridged."""
    return {
        "title": "Erste Führung",
        "source": "FKS Plakat «Erste Führung» A3 V 1.0/10.09.2019",
        "columns": 2,
        "sections": [
            {
                "id": "problem",
                "type": "quad",
                "title": "Problemerfassung",
                "height": 11,
                "cells": [
                    {"label": "Front", "lines": [{"text": "Rettungen Haus 19"}, {"text": "Brand Haus 21"}]},
                    {"label": "Ordnung", "lines": [{"text": "R-Achse"}]},
                    {"label": "Sanität", "lines": [{"text": "> 5 Patienten"}]},
                    {"label": "Spezialprobleme", "lines": []},
                ],
            },
            {"id": "lagekarte", "type": "map", "title": "Lagekarte", "height": 11},
            {
                "id": "massnahmen",
                "type": "table",
                "title": "Massnahmen",
                "height": 11,
                "columns": [
                    {"label": "Was/Wo", "w": 4.2},
                    {"label": "Wer", "w": 1.75},
                    {"label": "Wann", "kind": "time"},
                ],
                "rows": [{"cells": [f"Massnahme {i + 1}", "TLF 1", "17:42"]} for i in range(massnahmen_rows)],
            },
            {
                "id": "absprachen",
                "type": "table",
                "title": "Abspracherapport",
                "subtitle": "Feuerwehr – Polizei – Rettungsdienst",
                "height": 12,
                "adds": False,
                "columns": [
                    {"label": "Signatur", "kind": "symbol", "w": 1.55},
                    {"label": "Bezeichnung", "w": 1.5},
                    {"label": "Ort", "w": 2.4},
                ],
                "rows": [
                    {"fixed": True, "cells": ["patientensammelstelle", f"Patienten{SHY}sammelstelle", ""]},
                    {"fixed": True, "cells": ["warteraum", "Warteraum", "Parkplatz Coop"]},
                ],
            },
        ],
    }


def _text(pdf: bytes) -> str:
    doc = pdfium.PdfDocument(io.BytesIO(pdf))
    return "\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))


def _compose(**extra) -> bytes:
    payload = ReportPayload.model_validate(
        {"incident": {"title": "Brand Schlossgasse", "id": "x"}, "generatedAt": "10.10.2026 18:05", **extra}
    )
    return compose_report_pdf(payload, {})


def test_the_erste_fuehrung_prints_as_its_poster():
    text = _text(_compose(boardPages=[_ef()]))
    for word in (
        "Erste Führung",
        "Problemerfassung",
        "Lagekarte",
        "Rettungen Haus 19",
        "Feuerwehr – Polizei – Rettungsdienst",
        "Parkplatz Coop",
        "Massnahme 2",
    ):
        assert word in text, word
    # the poster's own split, from the template's soft hyphen (pdfium reads a line-end hyphen
    # back as U+FFFE)
    assert ("Patienten-" in text or "Patienten\ufffe" in text) and "sammelstelle" in text
    assert "FKS Plakat" in text  # where the page comes from, in its footer


def _glyph_height(pdf: bytes, needle: str) -> float:
    """The printed height (pt) of the first character of `needle`, wherever it lands."""
    doc = pdfium.PdfDocument(io.BytesIO(pdf))
    for i in range(len(doc)):
        tp = doc[i].get_textpage()
        found = tp.search(needle, match_whole_word=True).get_next()
        if found:
            left, bottom, right, top = tp.get_charbox(found[0], loose=False)
            return top - bottom
    raise AssertionError(f"{needle!r} is not on the paper")


@pytest.mark.parametrize("rows", [80, 350])
def test_nothing_written_is_cut_off_or_shrunk_away(rows):
    """A box holding more than fits at a legible size continues after the page, at full size and
    over as many pages as it needs — measured on the paper, not read back as text."""
    pdf = _compose(boardPages=[_ef(massnahmen_rows=rows)])
    assert "Fortsetzung: Massnahmen" in _text(pdf)
    # the last row is there, and as legible as the first one on the continuation
    last = _glyph_height(pdf, f"Massnahme {rows}")
    assert last >= 5.0, last
    assert abs(last - _glyph_height(pdf, "Massnahme 40")) < 0.5
    # …which takes pages: ~45 rows a page at that size
    pages = len(pdfium.PdfDocument(io.BytesIO(pdf)))
    assert pages >= 2 + (rows - 20) // 60


def test_an_older_client_prints_what_it_always_did():
    assert "Erste Führung" not in _text(_compose())


def test_the_operator_can_leave_the_tafel_out():
    assert "Problemerfassung" not in _text(_compose(boardPages=[_ef()], options={"tafel": False}))


def test_a_landscape_sheet_and_a_text_page():
    konzept = {
        "title": "Konzept",
        "columns": 2,
        "sections": [
            {
                "id": "auftrag",
                "type": "text",
                "title": "Auftrag",
                "span": 2,
                "height": 3,
                "fields": [{"tone": "shade", "value": "Personen retten, Ausbreitung verhindern"}],
            },
            {
                "id": "v1",
                "type": "text",
                "title": "Variante 1",
                "layout": "split",
                "height": 15,
                "fields": [
                    {"value": "Innenangriff"},
                    {"label": "+", "tone": "plus", "value": "schnell"},
                    {"label": "–", "tone": "minus"},
                ],
            },
            {
                "id": "v2",
                "type": "text",
                "title": "Variante 2",
                "layout": "split",
                "height": 15,
                "fields": [
                    {"value": "Aussenangriff"},
                    {"label": "+", "tone": "plus"},
                    {"label": "–", "tone": "minus", "value": "langsam"},
                ],
            },
        ],
    }
    tendenz = {
        "title": "Problemerfassung",
        "landscape": True,
        "columns": 1,
        "sections": [
            {
                "id": "p",
                "type": "table",
                "height": 10,
                "columns": [{"label": "Problem/Ereignis", "w": 4}, {"label": "Entwicklungstendenz", "kind": "trend"}],
                "rows": [{"cells": ["Brand Zisternenfahrzeug", "wird schlimmer"]}],
            }
        ],
    }
    pdf = _compose(boardPages=[konzept, tendenz])
    text = _text(pdf)
    for word in (
        "Konzept",
        "Personen retten",
        "Innenangriff",
        "langsam",
        "Brand Zisternenfahrzeug",
        "wird schlimmer",
    ):
        assert word in text, word
    doc = pdfium.PdfDocument(io.BytesIO(pdf))
    sizes = [doc[i].get_size() for i in range(len(doc))]
    assert any(w > h for w, h in sizes)  # the 8.1 sheet is landscape, like the Handbuch's


def test_wrapping_splits_where_the_template_says():
    assert wrap(f"Patienten{SHY}sammelstelle", 25 * mm, size=9) == ["Patienten-", "sammelstelle"]
    assert wrap(f"Sanitäts{SHY}hilfsstelle", 60 * mm, size=9) == ["Sanitätshilfsstelle"]  # no hyphen when it fits
    assert wrap("Erste Zeile\nzweite", 60 * mm) == ["Erste Zeile", "zweite"]
    # Helvetica has no trend arrows: a label keeps its meaning instead of printing «?»
    assert wrap("Entwicklungstendenz ➚ = ➘", 90 * mm) == ["Entwicklungstendenz (+) = (–)"]
    # a narrow column shrinks the type before it splits a word
    assert fit_size("Polycom", 9 * mm, 8.5) < 8.5


def test_the_tendenz_prints_as_an_arrow_beside_the_problem(monkeypatch):
    """The Erste Führung's Problemerfassung carries the trend (owner, round 2): the paper draws
    ➚ = ➘ as vector arrows — Helvetica has none — in front of the line."""
    import app.report_board as rb

    drawn: list[str] = []
    real = rb.trend_arrow
    monkeypatch.setattr(rb, "trend_arrow", lambda c, d, *a: (drawn.append(d), real(c, d, *a)))
    page = _ef()
    page["sections"][0]["trend"] = True
    page["sections"][0]["cells"][0]["lines"] = [
        {"text": "Rettungen Haus 19", "trend": "wird schlimmer", "dir": "up"},
        {"text": "Rauch", "trend": "gleich", "dir": "same"},
        {"text": "Brand Haus 21"},
    ]
    text = _text(_compose(boardPages=[page]))
    assert drawn == ["up", "same"]
    assert "Rettungen Haus 19" in text and "Rauch" in text


def test_the_header_line_prints_in_the_words_it_was_sent_in():
    page = _ef()
    page["head"] = [{"label": "Intervention", "value": "Feu de cuisine"}, {"label": "Adresse", "value": ""}]
    text = _text(_compose(boardPages=[page]))
    assert "Intervention: Feu de cuisine" in text
    assert "Einsatz:" not in text
