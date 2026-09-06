"""The script-src CSP (app/csp.py) — the hash must track the served index.html.

The inline theme-boot script in index.html is deliberate (night launch must not flash a
day screen), so the CSP allows it by sha256 hash computed from the file this process
serves. These tests pin the two ways that can go wrong: the hash not matching the bytes
browsers hash (exact content between the tags), and an external-src script being treated
as inline.
"""

import base64
import hashlib
from pathlib import Path

from app.csp import build_csp, csp_for


def _write_index(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "index.html"
    p.write_text(body, encoding="utf-8")
    return p


def test_inline_script_is_allowed_by_exact_hash(tmp_path):
    script = "var t = 'night'\ndocument.documentElement.dataset.theme = t\n"
    index = _write_index(tmp_path, f"<html><head><script>{script}</script></head></html>")
    expected = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    csp = build_csp(index)
    assert f"'sha256-{expected}'" in csp
    assert "'unsafe-inline'" not in csp


def test_external_scripts_get_no_hash_and_self_stands(tmp_path):
    index = _write_index(
        tmp_path,
        '<html><script type="module" crossorigin src="/assets/index-abc.js"></script></html>',
    )
    csp = build_csp(index)
    assert "sha256-" not in csp
    assert "script-src 'self' 'wasm-unsafe-eval';" in csp


def test_missing_index_yields_a_policy_without_hashes(tmp_path):
    csp = build_csp(tmp_path / "absent.html")
    assert "script-src 'self'" in csp
    assert "sha256-" not in csp


def test_csp_directives_cover_the_verified_surface(tmp_path):
    """worker blob: (MapLibre), wasm (pdf.js), object/base hardening — see csp.py."""
    csp = build_csp(_write_index(tmp_path, "<html></html>"))
    assert "worker-src 'self' blob:" in csp
    assert "object-src 'none'" in csp
    assert "base-uri 'self'" in csp
    assert "frame-ancestors 'self'" in csp


def test_csp_for_rebuilds_when_the_file_changes(tmp_path):
    """A from-source rebuild under a running server must not keep the stale hash."""
    index = _write_index(tmp_path, "<html><script>var a = 1\n</script></html>")
    first = csp_for(index)
    index.write_text("<html><script>var a = 2\n</script></html>", encoding="utf-8")
    # mtime granularity: force a distinct timestamp so the cache key changes deterministically
    import os

    st = index.stat()
    os.utime(index, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    second = csp_for(index)
    assert first != second


def test_inline_script_matching_survives_browser_grade_tag_variants(tmp_path):
    """<SCRIPT>, </SCRIPT > and </ScRiPt> are all the same element to a browser — which is
    why the extraction is a real HTML parser (stdlib HTMLParser), not a regex trying to
    enumerate tag forms (CodeQL py/bad-tag-filter). Python ≤3.13's parser still refuses the
    junk-attribute end tag (``</script bar>``) that 3.14 accepts — tolerable, because Vite
    only ever emits ``</script>`` and a missed variant fails CLOSED: no hash is minted, the
    script is blocked, and a hand-mangled index.html announces itself in the first boot."""
    script = "var x = 1\n"
    expected = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    for start, end in (("<SCRIPT>", "</SCRIPT >"), ("<script>", "</ScRiPt>"), ("<ScRiPt>", "</script>")):
        index = _write_index(tmp_path, f"<html>{start}{script}{end}</html>")
        assert f"'sha256-{expected}'" in build_csp(index), (start, end)
