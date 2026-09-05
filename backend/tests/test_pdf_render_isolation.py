"""The two renderers only ever draw what the server itself resolved.

A Rapport carries client-authored strings into two native renderers: journal ``markup`` goes
into a ReportLab ``Paragraph``, and a client-resolved ``symbolSvg`` goes into resvg. Both
accept image references, so both used to be able to make the server read image files by path
(SEC-07). What the app actually produces is bold names, a link and the odd underline — that is
the whole vocabulary these tests pin, on both sides: nothing external in, everything the
Rapport really needs still out.
"""

import io

import pytest
from PIL import Image

from app import kroki as kk
from app.report_pdf import ReportPayload, compose_report_pdf

MAGENTA = (255, 0, 255)


@pytest.fixture
def secret_png(tmp_path):
    """A file on the server's disk that no caller is allowed to pull into a Rapport.

    Noise, not a flat colour: an embedded copy survives PDF compression and is then visible as
    a size jump, which is what the markup test measures.
    """
    import random

    rnd = random.Random(7)
    img = Image.new("RGB", (220, 220))
    img.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(220 * 220)])
    p = tmp_path / "geheim.png"
    img.save(p, "PNG")
    return p


def _pdf(markup: str | None) -> bytes:
    payload = ReportPayload.model_validate(
        {
            "incident": {"title": "T", "id": "i"},
            "generatedAt": "n",
            "options": {"kroki": False},
            "journal": [
                {"timeLabel": "14:31", "area": "EL", "text": "Meldung", **({"markup": markup} if markup else {})}
            ],
        }
    )
    return compose_report_pdf(payload, {})


# --- journal markup ------------------------------------------------------------------------


def test_markup_cannot_pull_a_file_off_the_server(secret_png):
    """SEC-03's sibling: report generation is open to every editor and to the capture token."""
    plain = _pdf(None)
    injected = _pdf(f'<b>Meldung</b> <img src="{secret_png}" width="180" height="180"/>')
    assert len(injected) < len(plain) + 5_000, "a local image was embedded into the Rapport"


@pytest.mark.parametrize(
    "markup",
    [
        '<img src="/etc/hosts"/>',
        '<img src="https://evil.example/pixel.png" width="10" height="10"/>',
        '<para><onDraw name="x"/></para>',
        '<font face="../../etc/passwd">x</font>',
    ],
)
def test_no_external_resource_directive_survives(markup):
    from app.report_pdf import safe_markup

    out = safe_markup(markup)
    assert "img" not in out.lower()
    assert "ondraw" not in out.lower()
    assert "face" not in out.lower()


def test_the_markup_the_app_produces_is_kept():
    """src/lib/journalLinks.ts · linkMarkup — a bold vocabulary name, a linked address, and the
    escaping the client already did. All of it has to survive verbatim, or the Beilage prints
    tag soup where the record has names."""
    from app.report_pdf import safe_markup

    src = '<b>Müller Hans</b> (GF) meldet <a href="tel:+41791234567"><u>079 123 45 67</u></a> &amp; R&amp;D'
    assert safe_markup(src) == src
    assert safe_markup("Wasser &lt;-&gt; Schaum") == "Wasser &lt;-&gt; Schaum"
    assert safe_markup("<i>kursiv</i> <b>fett</b><br/>zweite Zeile") == "<i>kursiv</i> <b>fett</b><br/>zweite Zeile"


def test_a_link_to_something_the_reader_cannot_tap_keeps_its_words():
    from app.report_pdf import safe_markup

    out = safe_markup('<a href="javascript:alert(1)"><u>klick</u></a>')
    assert "javascript" not in out and "klick" in out


def test_broken_markup_never_takes_the_rapport_down():
    from app.report_pdf import safe_markup

    assert safe_markup("<b>unbalanciert") == "<b>unbalanciert</b>"  # closed, never left dangling
    assert safe_markup("fett</b> ohne Anfang") == "fett ohne Anfang"
    assert safe_markup("2 < 3 & 4 > 1") == "2 &lt; 3 &amp; 4 &gt; 1"


def test_a_bold_journal_row_still_prints():
    pdf = _pdf("<b>Müller Hans</b> meldet Wasser am Verteiler")
    assert pdf[:5] == b"%PDF-" and len(pdf) > 3_000


# --- client SVG ----------------------------------------------------------------------------


def _has_magenta(img: Image.Image) -> bool:
    colors = img.convert("RGB").getcolors(maxcolors=1_000_000) or []
    return any(c == MAGENTA for _, c in colors)


def test_a_client_svg_cannot_reference_a_file_on_disk(tmp_path):
    p = tmp_path / "leak.png"
    Image.new("RGB", (64, 64), MAGENTA).save(p, "PNG")
    for href in (str(p), f"file://{p}", p.as_uri()):
        svg = (
            '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" '
            'xmlns:xlink="http://www.w3.org/1999/xlink">'
            f'<image x="0" y="0" width="64" height="64" href="{href}"/>'
            f'<image x="0" y="0" width="64" height="64" xlink:href="{href}"/>'
            "</svg>"
        )
        assert not _has_magenta(kk.raster_svg(svg, 64)), href


def test_a_client_svg_cannot_pull_a_remote_resource(tmp_path):
    svg = (
        '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">'
        '<style>@import url("http://127.0.0.1:9999/x.css");</style>'
        '<image width="64" height="64" href="http://127.0.0.1:9999/x.png"/>'
        "</svg>"
    )
    img = kk.raster_svg(svg, 64)  # must not raise and must not reach the network
    assert img.size == (64, 64)


def test_an_entity_declaration_never_reaches_the_renderer():
    svg = (
        '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/hosts">]>'
        '<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><text y="10">&xxe;</text></svg>'
    )
    assert kk.sanitize_svg(svg).count("<!") == 0


def test_a_drawing_colour_cannot_open_an_attribute():
    """The Rapport payload carries its own copy of every drawing's colour and never passes the
    workspace scrub (schemas · _scrub_drawing_props), so the compositor validates it again."""
    assert "onload" not in kk.spread_overlay_svg({"up": True}, '#fff" onload="alert(1)')
    assert kk._safe_color("#1f6feb") == "#1f6feb"
    assert kk._safe_color("rgb(31, 111, 235)") == "rgb(31, 111, 235)"
    assert kk._safe_color('</svg><image href="/etc/hosts"/>') == "#1f6feb"


def test_a_quote_mismatched_href_cannot_reference_a_file(tmp_path):
    """SEC-07 (05.09.): the old value class excluded BOTH quotes, so a valid double-quoted href
    whose value held an apostrophe was never matched and the reference survived the scrub. Codex
    embedded a generated PNG through exactly such an attribute and it rendered."""
    p = tmp_path / "lea'k.png"  # an apostrophe INSIDE a double-quoted attribute value
    Image.new("RGB", (64, 64), MAGENTA).save(p, "PNG")
    svg = (
        '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">'
        f'<image x="0" y="0" width="64" height="64" href="{p}"/></svg>'
    )
    assert not _has_magenta(kk.raster_svg(svg, 64)), "a quote-mismatched href reached the filesystem"


def test_sanitize_neutralises_quote_mismatched_refs():
    assert "/srv/x" not in kk.sanitize_svg('<image href="/srv/x\'.png"/>')
    # both attribute names survive as DISTINCT empty attrs — a double `href=""` would be a
    # duplicate resvg rejects, turning a scrub into a parse error
    out = kk.sanitize_svg('<image href="/a\'.png" xlink:href="/b\'.png"/>')
    assert 'href=""' in out and 'xlink:href=""' in out
    # a single-quoted url() holding a double-quote is caught too
    assert "evil" not in kk.sanitize_svg("<rect fill='url(\"http://evil/x#a\")'/>")


def test_an_href_planted_in_another_attribute_cannot_reference_a_file(tmp_path):
    """SEC-07 (round 2, 05.09.): a quote-aware regex still starts on a decoy `href` PLANTED in a
    `data-*` value, runs across the genuine local-file `href`, and keeps the whole span because
    the value it captured opens with «#». Only a parser tells an attribute from a value — Codex
    embedded a generated PNG through exactly this shape and it rendered."""
    p = tmp_path / "planted.png"
    Image.new("RGB", (64, 64), MAGENTA).save(p, "PNG")
    svg = (
        '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">'
        f'<image data-note="href=\'#" href="{p}" data-tail="\'" width="64" height="64"/></svg>'
    )
    assert str(p) not in kk.sanitize_svg(svg), "the real href survived the parse"
    assert not _has_magenta(kk.raster_svg(svg, 64)), "a planted-decoy href reached the filesystem"


def test_scripting_and_foreignobject_never_reach_the_renderer():
    """A parser can drop whole elements a regex could only hope to blank: `<script>`,
    `<foreignObject>` (an HTML escape hatch) and every `on*` event handler."""
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<script>fetch("http://evil/x")</script>'
        '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>'
        '<rect onload="alert(1)" onclick="x" width="8" height="8"/></svg>'
    )
    out = kk.sanitize_svg(svg).lower()
    assert "script" not in out and "foreignobject" not in out
    assert "onload" not in out and "onclick" not in out and "evil" not in out


def test_a_journal_link_carrying_a_quote_prints_and_stays_escaped():
    """SEC-07 (05.09.): a decoded link (`&quot;` → a literal `"`) was inserted into the quoted
    ReportLab attribute unescaped, so it closed the `href="…"` and ReportLab raised — broken
    printing and an escaping gap. It is escaped for attribute context now."""
    from app.report_pdf import safe_markup

    out = safe_markup('<a href="https://example.test/x&quot;y"><u>klick</u></a>')
    assert 'href="https://example.test/x&quot;y"' in out, out  # the quote is escaped, never raw
    pdf = _pdf('<a href="https://example.test/x&quot;y"><u>klick</u></a>')
    assert pdf[:5] == b"%PDF-" and len(pdf) > 3_000  # ReportLab parsed the anchor without raising


@pytest.mark.parametrize(
    "svg",
    [
        '<!DOCTYPE svg [<!ENTITY x "a]b">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><image href=/unquoted.png /></svg>',
        "<svg xmlns='http://www.w3.org/2000/svg'><rect fill='#zzz' width='not-a-number'/></svg>",
        "<not-svg at all",
    ],
)
def test_a_hostile_symbol_svg_yields_an_empty_glyph_never_a_500(svg):
    """SEC-01 server side (05.09.): a crafted `symbolSvg` resvg refuses to parse must become an
    empty box, not a raise that turns render_kroki into a 500 for the whole incident."""
    img = kk.raster_svg(svg, 48)
    assert img.size == (48, 48)


def test_the_glyphs_a_rapport_needs_still_render(tmp_path):
    # a pack symbol (the client's own artwork)
    pack = kk.get_pack()
    assert pack is not None
    assert pack.raster("VKF Feuer", 48) is not None
    # an inline data: image — how an admin's SVG brandmark carries its raster half
    logo = io.BytesIO()
    Image.new("RGB", (8, 8), MAGENTA).save(logo, "PNG")
    import base64

    uri = "data:image/png;base64," + base64.b64encode(logo.getvalue()).decode()
    svg = (
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">'
        f'<image x="0" y="0" width="32" height="32" href="{uri}"/></svg>'
    )
    assert _has_magenta(kk.raster_svg(svg, 32))
    # a fragment reference (gradients, the spread overlay's own defs)
    grad = (
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">'
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff00ff"/>'
        '<stop offset="1" stop-color="#ff00ff"/></linearGradient></defs>'
        '<rect width="32" height="32" fill="url(#g)"/></svg>'
    )
    assert _has_magenta(kk.raster_svg(grad, 32))
