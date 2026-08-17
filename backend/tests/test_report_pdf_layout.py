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


def test_the_atemschutz_sheet_names_the_interval_ueberfaellig_was_measured_against():
    """«überfällig» is a judgement against a Funkkontakt-Intervall, and the sheet never said
    which one. It is a per-incident setting on top of a per-station one, so a reader six months
    later has nowhere to look it up — it has to travel with the document."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "atemschutzIntervalMin": 10,
            "atemschutzGraceSec": 300,
            "trupps": [{"name": "Schmid Peter", "statusLabel": "im Einsatz", "readings": []}],
        }
    )
    text = _text(compose_report_pdf(payload, {}))
    assert "Funkkontakt-Intervall: 10 min" in text
    assert "+5 min" in text


def test_the_atemschutz_sheet_says_nothing_about_an_interval_it_was_not_told():
    """A rapport built by an older client sends no interval. Printing a default would state a
    rule this Einsatz may never have run on, on the sheet that records whether it was kept."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "trupps": [{"name": "Schmid Peter", "statusLabel": "im Einsatz", "readings": []}],
        }
    )
    assert "Funkkontakt-Intervall" not in _text(compose_report_pdf(payload, {}))


def test_a_trupp_that_never_went_under_pa_says_so_instead_of_an_austritt():
    """The Sicherungstrupp that stood ready and was stood down.

    It carries an exit stamp like any closed Trupp, and the sheet printed that stamp as
    «Austritt» — claiming a crew came out of a building it never entered. On the one document
    that records who was exposed, that is the whole difference the row exists to state.
    """
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "trupps": [
                {
                    "name": "Weber Marco",
                    "statusLabel": "Nicht eingesetzt",
                    "members": ["Huber Sarah"],
                    "entryTime": None,
                    "exitTime": "07.08.2026 03:40",
                    "readings": [],
                },
                {
                    "name": "Schmid Peter",
                    "statusLabel": "Draussen",
                    "members": [],
                    "entryTime": "07.08.2026 03:05",
                    "exitTime": "07.08.2026 03:32",
                    "readings": [],
                },
            ],
        }
    )
    text = _text(compose_report_pdf(payload, {}))
    assert "Nicht eingesetzt" in text
    # …and the Trupp that DID go in still gets the ordinary pair
    assert "Eintritt" in text and "Austritt" in text


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


def test_every_trupp_block_shares_one_tab_stop():
    """The label column was sized per Trupp, so a block carrying «Auftrag / Ziel» put its values
    ~14mm in and the next one — «AdF 1» and nothing else — put them ~8mm in. Down a page of
    Trupps every block started at a different x and the pressure logs stepped in and out with
    them. One width for the whole section."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "trupps": [
                {
                    "name": "Brunner Thomas",
                    "statusLabel": "im Einsatz",
                    "members": ["Frei Nina"],
                    "auftrag": "Sichern",  # the long label — «Auftrag / Ziel:»
                    "readings": [{"t": "09:05", "kindLabel": "Eintritt", "bar": "300"}],
                },
                {
                    "name": "Huber Sarah",
                    "statusLabel": "im Einsatz",
                    "members": ["Meier Anna"],  # short labels only — «AdF 1:»
                    "readings": [{"t": "09:07", "kindLabel": "Eintritt", "bar": "300"}],
                },
            ],
        }
    )
    doc = pdfium.PdfDocument(compose_report_pdf(payload, {}))
    page = doc[len(doc) - 1]
    tp = page.get_textpage()

    def left_of(needle: str) -> float:
        return next(
            tp.get_rect(i)[0] for i in range(tp.count_rects()) if needle in tp.get_text_bounded(*tp.get_rect(i))
        )

    # the two value columns, and both pressure logs that hang off them
    assert abs(left_of("Frei Nina") - left_of("Meier Anna")) < 1.5
    zeit = [tp.get_rect(i)[0] for i in range(tp.count_rects()) if "Zeit" in tp.get_text_bounded(*tp.get_rect(i))]
    assert len(zeit) == 2, f"expected one pressure log per Trupp, got {len(zeit)}"
    assert abs(zeit[0] - zeit[1]) < 1.5


def test_the_signature_rule_starts_after_the_name_not_through_it():
    """A Visum row reads as ONE line — «Einsatzleiter: Anna Meier ______» — so the rule sits on
    the row's own baseline and starts where the name ends. Drawn from the label it would
    underline the name; hung a writing height below (as it was until 2026-08-08) it put two
    rules at two heights in one row, the lower one nearer the NEXT row's label than its own
    name. Guards the gap between the rows too — they must not crowd each other."""
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
    # the two Visum rows stay a writing height apart — a form, not a poster
    gap = el[1] - kdt[3]
    assert gap > 22, f"only {gap:.1f} pt between the two Visum rows — no room to sign"

    # and the rule does not run through the name: nothing is drawn on the row's rule line
    # across the name's own span, while the stretch to its right is where the rule lives.
    scale = 3
    px = page.render(scale=scale).to_pil().convert("L").load()
    rule_y = int((page.get_height() - el[1] + 0.6 * 72 / 25.4) * scale)
    x0, x1 = int(el[0] * scale) + 2, int(el[2] * scale) - 2
    under_name = [
        y for y in range(rule_y - 3, rule_y + 4) if sum(1 for x in range(x0, x1) if px[x, y] < 200) > (x1 - x0) * 0.2
    ]
    assert not under_name, "the signature rule runs through the Einsatzleiter's name"


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


def test_the_join_number_prints_and_the_uuid_does_not():
    """WinFAP is joined on the alerting system's own alarm reference, whose short form is its
    FIRST four hex — not on this app's incident UUID, which joins nothing. Printing both put two
    number-looking things on one sheet, and the case-number field only wants one of them. So the
    Einsatz-Nr sits in the details box (where a form is filled in from) and the Einsatz-ID is off
    the footer entirely."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "3f2a91c4-77bd-4c1e-9a55-0e21b7d4239d"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
        }
    )
    plain = pdfium.PdfDocument(compose_report_pdf(payload, {}))[0].get_textpage().get_text_range()
    assert "Einsatz-ID" not in plain
    assert "3f2a91c4" not in plain, "the incident UUID must not reach the paper"
    assert "Einsatz-Nr" not in plain, "no reference, no row — an empty label invites the wrong number"

    payload.incident.alarmRef = "fwo-sms-761610d931ac"
    withref = pdfium.PdfDocument(compose_report_pdf(payload, {}))[0].get_textpage().get_text_range()
    assert "Einsatz-Nr" in withref
    # the short form is what gets typed, so it leads; the full reference follows for checking
    # against the printed slip
    assert "7616 · fwo-sms-761610d931ac" in withref
    assert "Einsatz-ID" not in withref


def test_dispatch_text_loses_its_emoji_before_it_reaches_the_page():
    """Helvetica draws a black box for a pictograph, and the Stichwort is set 20pt at the top of
    the sheet. The app blocks emoji where text is TYPED, but the Stichwort/Kategorie/Adresse
    arrive from the ELZ verbatim and nobody here can edit them in a guarded field."""
    from app.report_pdf import IncidentFacts, ReportMetaIn

    f = IncidentFacts(
        title="Brand \U0001f525 Hauptstrasse 4", type="Brand ✅", address="Hauptstr. 4 \U0001f3e0", id="x"
    )
    assert (f.title, f.type, f.address) == ("Brand Hauptstrasse 4", "Brand", "Hauptstr. 4")
    assert ReportMetaIn(alarmText="Zimmerbrand \U0001f692 2. OG").alarmText == "Zimmerbrand 2. OG"
    # everything Helvetica CAN set stays exactly as the ELZ sent it
    assert (
        IncidentFacts(title="Öl · Hauptstrasse 4 – 2. OG «Nord»", id="x").title == "Öl · Hauptstrasse 4 – 2. OG «Nord»"
    )
    # a title that is nothing but an emoji keeps it: a box says something was sent, blank does not
    assert IncidentFacts(title="\U0001f525", id="x").title == "\U0001f525"


def test_a_guest_is_marked_as_one_on_the_roster():
    """A name that is not on the Mannschaftsliste has to say so ON THE SHEET.

    The app badges guests on the Anwesenheit screen; the printed Personalblatt appended them to
    the bottom of our own roster with nothing to distinguish them. The one reader who cannot ask
    — a Gemeinde or a Versicherung reading a signed rapport weeks later — then counted a
    Nachbarwehr's AdF as one of ours. A guest who also held a job prints both, guest first.
    """
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "personal": [
                {"name": "Meier Anna", "erfasst": True, "note": "Fahrer TLF"},
                {"name": "Bucher Urs", "erfasst": True, "guest": True},
                {"name": "Frei Nina", "erfasst": True, "guest": True, "note": "Fahrer ADL"},
            ],
        }
    )
    doc = pdfium.PdfDocument(compose_report_pdf(payload, {}))
    text = "".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))
    assert "Bucher Urs" in text
    assert "Gast" in text
    # the guest mark leads the remark rather than replacing it
    assert "Gast · Fahrer ADL" in text
    # …and one of ours is never marked
    assert "Meier Anna · Fahrer TLF" in text


def test_a_wrapping_partner_row_keeps_its_box_on_the_first_line():
    """The tick belongs beside the NAME, not beside the middle of it.

    A Partnerorganisation is free text with no length rule behind it, so a long one wraps to
    three lines — and a middle-aligned checkbox floated down next to the second. On a block whose
    whole use is reading down the boxes, the box then pointed at nothing.
    """
    long_org = "Blaulicht und sonst noch Leuchten die auf der Kerze nicht die hellsten sind"
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Zimmerbrand", "id": "i"},
            "generatedAt": "07.08.2026 09:00",
            "proof": {"statusLabel": "intakt", "count": 1, "head": "0"},
            "partnerPresets": [long_org, "Rotlicht"],
            "meta": {"partnerContacts": [{"org": long_org, "note": "War nicht vor Ort"}]},
        }
    )
    doc = pdfium.PdfDocument(compose_report_pdf(payload, {}))
    page = next(p for p in (doc[i] for i in range(len(doc))) if "Blaulicht" in p.get_textpage().get_text_range())
    tp = page.get_textpage()

    def top_of(needle: str) -> float:
        return next(
            tp.get_rect(i)[3] for i in range(tp.count_rects()) if needle in tp.get_text_bounded(*tp.get_rect(i))
        )

    # the ✗ in the box and the first word of the organisation share a line (within one line's
    # height); a middle-aligned box on a three-line row sat a full line-and-a-half below it
    assert abs(top_of("X") - top_of("Blaulicht")) < 6, "the tick is not on the organisation's first line"


def test_pendenzen_section_prints_after_the_journal():
    """⚠️ The section is a plain extra field on ``ReportPayload``, so a backend that has not been
    restarted silently DROPS it (pydantic ignores unknown keys) and the rapport comes out looking
    exactly as it did before — no error, no hint. This asserts the composer actually emits it."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Pendenz-Probe", "id": "p"},
            "generatedAt": "16.08.2026 22:00",
            "journal": [{"timeLabel": "21:58", "area": "Lage", "text": "Blablabla"}],
            "pendenzen": [
                {
                    "text": "Absperrmaterial Kreuzung",
                    "assignee": "Werkhof Oberwil",
                    "urgent": True,
                    "erteilt": "21:02",
                    "notes": [{"timeLabel": "21:19", "text": "Fahrzeug unterwegs"}],
                },
                {"text": "Öl binden Vorplatz", "erteilt": "21:18"},
            ],
        }
    )
    doc = pdfium.PdfDocument(io.BytesIO(compose_report_pdf(payload, {}, {})))
    text = "\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))

    assert "Aufträge / Pendenzen" in text
    assert "Absperrmaterial Kreuzung" in text
    assert "Werkhof Oberwil" in text
    # a Meldung prints as its own indented sub-line under the item
    assert "Fahrzeug unterwegs" in text
    # ⚠️ Urgency is a single «!» before the text, not a column and not the word — the legend in
    # the footer is the only place «dringend» is spelled out, once for the whole section.
    assert "! = dringend" in text
    # …and an item nobody ticked off says so, which is the point of printing the section at all
    assert "offen" in text


def test_pendenzen_section_is_absent_without_any():
    """An Einsatz that raised none must not print an empty table — the blank form costs paper."""
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "Ohne", "id": "p"},
            "generatedAt": "16.08.2026 22:00",
            "journal": [{"timeLabel": "21:58", "area": "Lage", "text": "Blablabla"}],
        }
    )
    doc = pdfium.PdfDocument(io.BytesIO(compose_report_pdf(payload, {}, {})))
    text = "\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))
    assert "Aufträge / Pendenzen" not in text
