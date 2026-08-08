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
    """Capped plates FLOW — a full-page plate each turned four photos into four sheets. Four also
    go TWO-UP: at 62 % width a single column of plates left the right half of every page empty."""

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
    # 4 photos, two-up: the form page + ONE Beilagen page — not four sheets, and no longer two
    assert len(pdfium.PdfDocument(pdf)) == 2


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


def test_the_atemschutz_sheet_numbers_its_adf_the_way_the_form_does():
    """The Trupp form numbers its crew «AdF 1», «AdF 2»; the sheet printed one «AdF: A, B» line.
    Two names for the same three people, and a comma list gives nobody a position to point at
    when the question is who the second man was. The Gruppenführer keeps no row: the heading
    above the block IS his name."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "trupps": [
                {
                    "name": "Schmid Peter",
                    "statusLabel": "im Einsatz",
                    "members": ["Keller Laura", "Frei Nina"],
                    "auftrag": "Löschen",
                    "readings": [],
                }
            ],
        }
    )
    text = _text(compose_report_pdf(payload, {}))
    assert "AdF 1" in text and "Keller Laura" in text
    assert "AdF 2" in text and "Frei Nina" in text
    assert "Schmid Peter" in text  # the heading, and the only place the GF is named
    assert "Gruppenführer" not in text


def test_the_pressure_log_shares_the_trupps_left_edge():
    """The readings table is narrower than the frame, so ReportLab's default CENTER floated it
    into the middle of the page while the Trupp name and «Auftrag / Ziel» above it sat at the
    margin. A protocol read down one edge, not scattered across the sheet."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "trupps": [
                {
                    "name": "Schmid Peter",
                    "statusLabel": "im Einsatz",
                    "members": [],
                    "readings": [{"t": "09:05", "kindLabel": "Eintritt", "bar": "300"}],
                }
            ],
        }
    )
    doc = pdfium.PdfDocument(compose_report_pdf(payload, {}))
    page = doc[len(doc) - 1]
    tp = page.get_textpage()
    # left edge of the Trupp heading vs. left edge of the table's first column header
    name_x = next(
        tp.get_rect(i)[0] for i in range(tp.count_rects()) if "Schmid" in tp.get_text_bounded(*tp.get_rect(i))
    )
    zeit_x = next(tp.get_rect(i)[0] for i in range(tp.count_rects()) if "Zeit" in tp.get_text_bounded(*tp.get_rect(i)))
    assert abs(zeit_x - name_x) < 6, f"table at x={zeit_x} is not aligned with the name at x={name_x}"


def test_the_signature_rule_sits_under_the_name_not_through_it():
    """«Einsatzleiter: Céline Widmer» used to be drawn with the rule on its own baseline, which
    underlined the name and left nowhere to sign. A Visum needs empty paper under the name it
    belongs to — so the two Visum rows have to stand a writing height apart."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "meta": {"einsatzleiter": "Widmer Céline", "kommandant": "Meier Hans"},
        }
    )
    doc = pdfium.PdfDocument(compose_report_pdf(payload, {}))
    page = next(p for p in (doc[i] for i in range(len(doc))) if "Unterschriften" in p.get_textpage().get_text_range())
    tp = page.get_textpage()

    def box(needle: str):
        """The LAST match on the page — the Einsatzleiter is also named in the details box at the
        top, and that one is not the Visum."""
        hits = [tp.get_rect(i) for i in range(tp.count_rects()) if needle in tp.get_text_bounded(*tp.get_rect(i))]
        assert hits, needle
        return min(hits, key=lambda r: r[1])  # lowest on the page (y grows upwards)

    el = box("Widmer")
    kdt = box("Meier")
    # The rule hangs _SIG_DROP (6 mm ≈ 17 pt) under the EL's name, and the signature is written
    # into the space ABOVE it — so the gap to the Kommandant row has to clear the drop with a
    # margin, or the rule lands on the next row's label. Not more: this is a form, not a poster.
    gap = el[1] - kdt[3]
    assert gap > 22, f"only {gap:.1f} pt between the two Visum rows — the rule has no room"


def test_the_roster_rows_are_tall_enough_to_write_in():
    """The tick and usually both clocks are filled in with a pen. At the old 1.8 pt padding the
    rows were legible and unwritable — two ballpoint digits do not fit between the line above and
    the line below. Guards the height without pinning the exact padding."""
    roster = [{"name": f"Muster {i}", "erfasst": False} for i in range(12)]
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "personal": roster,
        }
    )
    doc = pdfium.PdfDocument(compose_report_pdf(payload, {}))
    page = next(p for p in (doc[i] for i in range(len(doc))) if "Muster 0" in p.get_textpage().get_text_range())
    tp = page.get_textpage()

    def top_of(needle: str) -> float:
        return next(
            tp.get_rect(i)[3] for i in range(tp.count_rects()) if needle in tp.get_text_bounded(*tp.get_rect(i))
        )

    # consecutive names in the SAME column are one row apart
    # 2.8 pt of padding per side puts this near 15.5; the 1.8 it regressed from lands near 13.6,
    # which is what the threshold is calibrated to catch.
    pitch = top_of("Muster 0") - top_of("Muster 1")
    assert pitch > 14.5, f"roster rows are {pitch:.1f} pt apart — no room for a pen"


def test_a_full_roster_still_lands_on_a_sane_number_of_sheets():
    """Taller rows must not turn a village Wehr's rapport into a booklet."""
    roster = [{"name": f"Muster {i}", "erfasst": False} for i in range(28)]
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "personal": roster,
        }
    )
    doc = pdfium.PdfDocument(compose_report_pdf(payload, {}))
    assert len(doc) <= 3, f"{len(doc)} sheets for a 28-person roster"


def test_ort_datum_is_written_on_its_own_line_not_under_it():
    """«Ort, Datum: ______» is a value somebody fills in, like every other field on the sheet —
    only the NAME signs underneath. A pass that gave every signature-block field the drop put the
    Ort/Datum leader a writing-height below its own label, which reads as a stray rule."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "meta": {"einsatzleiter": "Widmer Céline", "kommandant": "Meier Hans"},
        }
    )
    doc = pdfium.PdfDocument(compose_report_pdf(payload, {}))
    page = next(p for p in (doc[i] for i in range(len(doc))) if "Unterschriften" in p.get_textpage().get_text_range())
    tp = page.get_textpage()
    ort = [tp.get_rect(i) for i in range(tp.count_rects()) if "Ort, Datum" in tp.get_text_bounded(*tp.get_rect(i))]
    assert len(ort) == 2, "both Visum rows carry an Ort/Datum field"
    # the two Ort/Datum labels sit one pitch apart — if either had been pushed down by a
    # signature drop the spacing between them would no longer be uniform
    gap = ort[0][1] - ort[1][1]
    assert 25 < gap < 40, f"the two Ort/Datum rows are {gap:.1f} pt apart"


def test_beilagen_pick_their_size_from_how_many_there_are():
    """«How many are there» changes what the pages are FOR: one document is photographed to be
    read off the paper, fifty are photographed so somebody can see which pictures exist."""

    def png() -> bytes:
        b = io.BytesIO()
        Image.new("RGB", (1200, 1600), (200, 210, 200)).save(b, "PNG")
        return b.getvalue()

    def pages(n: int) -> int:
        urls = [f"/api/media/a{i}" for i in range(n)]
        payload = ReportPayload.model_validate(
            {
                "incident": {"title": "Beilagen-Probe", "id": "p"},
                "generatedAt": "07.08.2026 01:00",
                "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
                "attachments": [{"url": u, "caption": f"Bild {i}"} for i, u in enumerate(urls)],
            }
        )
        return len(pdfium.PdfDocument(compose_report_pdf(payload, {f"photo:{u}": png() for u in urls})))

    # two full plates still share their page; twelve thumbnails do not need more sheets than eight
    assert pages(2) == 2
    assert pages(8) == pages(12) == 3
    # and the whole range stays bounded — a photo stack must never bury the signed part
    assert pages(30) <= 5


def test_both_rules_of_a_visum_row_sit_on_one_line():
    """«Ort, Datum» is written beside the name that signs, and only the NAME's rule was dropped a
    writing height — so the row printed two dotted rules at two different y, and the lower one
    ended up nearer the NEXT row's «Ort, Datum» label than the name it belongs to. It read as a
    line that had come adrift. A Visum row has ONE rule height.

    Rules are drawn paths, not text, so this measures the rendered page: for every rule in the
    signature column there must be one at the same height in the Ort/Datum column."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "meta": {"einsatzleiter": "Widmer Céline", "kommandant": "Meier Hans"},
        }
    )
    doc = pdfium.PdfDocument(compose_report_pdf(payload, {}))
    page = next(p for p in (doc[i] for i in range(len(doc))) if "Unterschriften" in p.get_textpage().get_text_range())
    scale = 3
    img = page.render(scale=scale).to_pil().convert("L")
    w, h = img.size
    px = img.load()
    tp = page.get_textpage()

    def lowest(needle: str):
        hits = [tp.get_rect(i) for i in range(tp.count_rects()) if needle in tp.get_text_bounded(*tp.get_rect(i))]
        assert hits, needle
        return min(hits, key=lambda r: r[1])

    # the Visum band, in image coordinates (PDF y grows up, the image's grows down)
    top = int((page.get_height() - lowest("Widmer")[1]) * scale) - 20
    bot = int((page.get_height() - lowest("Meier")[1]) * scale) + 90
    mid = w // 2

    def rule_ys(x0: int, x1: int) -> list[float]:
        """Mid-y of each horizontal band that is mostly ink across the span — a dotted rule."""
        rows = [
            y
            for y in range(max(0, top), min(h, bot))
            if sum(1 for x in range(x0, x1) if px[x, y] < 200) > (x1 - x0) * 0.2
        ]
        bands: list[list[int]] = []
        for y in rows:
            if bands and y - bands[-1][-1] <= 2:
                bands[-1].append(y)
            else:
                bands.append([y])
        return [sum(b) / len(b) for b in bands]

    # the signature column past its labels — only rules are wide enough to register here
    signature = rule_ys(mid + 20, int(0.94 * w))
    ortdatum = rule_ys(int(0.06 * w), mid - 20)
    assert len(signature) == 2, f"expected a rule per Visum row, found {signature}"
    for y in signature:
        assert any(abs(y - o) <= 2 for o in ortdatum), (
            f"the signature rule at y={y:.1f} has no «Ort, Datum» rule level with it (found {ortdatum})"
        )
