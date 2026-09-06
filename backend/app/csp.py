"""The script half of the Content-Security-Policy (the compatibility-sensitive half).

`security_headers` in main.py has always shipped the safe half (nosniff, referrer,
frame-ancestors); this module supplies the rest, switched on 06.09. after verifying the
three known compatibility risks by hand:

- **MapLibre** builds its worker from a Blob URL (``createObjectURL(new Blob([worker
  bundle]))`` in maplibre-gl 4.x) → ``worker-src`` needs ``blob:``.
- **pdf.js** loads its worker as a same-origin emitted asset (``pdf.worker.min-<hash>.mjs``
  via ``?url`` — see PdfViewport.tsx) and instantiates WebAssembly for some image codecs →
  ``'self'`` covers the worker, ``'wasm-unsafe-eval'`` covers the WASM. That keyword allows
  ONLY WebAssembly compilation, never JS ``eval``.
- **The inline theme-boot script** in index.html is deliberate (a night launch must not
  flash a day screen while the bundle parses) and must keep working without
  ``'unsafe-inline'`` — so its exact bytes are allowed by hash. The hash is computed HERE,
  at runtime, from the very ``dist/index.html`` this process serves: a frontend edit can
  change the script, and a hash hard-coded in Python would then silently break the boot
  theme on the next deploy. Reading the served file makes drift impossible.

``script-src`` without ``'unsafe-inline'`` also blocks ``javascript:`` URLs — the
defence-in-depth layer behind the journal-attachment URL validation (schemas.py).
"""

import base64
import hashlib
import logging
from html.parser import HTMLParser
from pathlib import Path

logger = logging.getLogger(__name__)


class _InlineScripts(HTMLParser):
    """Collects the exact text of every <script> WITHOUT a src= (the module bundle keeps
    loading via 'self').

    A real parser, not a regex: browsers accept ``</SCRIPT >``, ``</script\\t bar>`` and
    friends as end tags, and CodeQL (py/bad-tag-filter) rightly kept refusing every regex
    that tried to enumerate them. Script content is CDATA to HTMLParser, so ``handle_data``
    receives it verbatim — the hash covers the same characters a browser hashes.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.scripts: list[str] = []
        self._buf: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "script" and not any(k == "src" for k, _ in attrs):
            self._buf = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._buf is not None:
            self.scripts.append("".join(self._buf))
            self._buf = None

    def handle_data(self, data: str) -> None:
        if self._buf is not None:
            self._buf.append(data)


def _inline_script_hashes(index_html: Path) -> list[str]:
    """CSP sha256 source expressions for every inline script in the served index.html.

    Missing file (API running standalone in dev, Vite serving the SPA) → no hashes needed,
    because this process then serves no HTML.
    """
    try:
        html = index_html.read_text(encoding="utf-8")
    except OSError:
        return []
    parser = _InlineScripts()
    parser.feed(html)
    parser.close()
    hashes = []
    for script in parser.scripts:
        digest = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii")
        hashes.append(f"'sha256-{digest}'")
    return hashes


def build_csp(index_html: Path) -> str:
    """The full CSP header value for app responses.

    Only the directives we have verified are set — no ``default-src``, so images, styles,
    fonts, tiles and API connections stay ungoverned rather than breaking one by one.
    ``object-src 'none'`` and ``base-uri 'self'`` close the classic escape hatches
    (plugin content, <base> pivots) at zero compatibility cost for this app.
    """
    hashes = _inline_script_hashes(index_html)
    if hashes:
        logger.info("CSP: allowing %d inline boot script(s) by hash from %s", len(hashes), index_html.name)
    script_src = " ".join(["'self'", "'wasm-unsafe-eval'", *hashes])
    return (
        f"frame-ancestors 'self'; script-src {script_src}; worker-src 'self' blob:; object-src 'none'; base-uri 'self'"
    )


# (path, mtime_ns) → header value. Rebuilt when index.html changes on disk: a from-source
# station that rebuilds the frontend under a running uvicorn would otherwise keep serving a
# hash for the OLD boot script and silently break the night-launch theme. The stat() per
# request is noise next to the response it decorates.
_cache: tuple[tuple[str, int], str] | None = None


def csp_for(index_html: Path) -> str:
    global _cache
    try:
        key = (str(index_html), index_html.stat().st_mtime_ns)
    except OSError:
        key = (str(index_html), -1)
    if _cache is None or _cache[0] != key:
        _cache = (key, build_csp(index_html))
    return _cache[1]
