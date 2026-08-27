"""CARTO basemap key handling for SERVER-side tile fetches (Rapport/Kroki, plan pages).

The browser half of this lives in ``src/lib/carto.ts``. The two halves answer the same
question — «does this raster template carry the deployment's CARTO key?» — for two different
fetchers, and the split matters:

* The BROWSER must carry the key, because MapLibre is what talks to the CDN. It is a public
  credential there by construction, protected by CARTO's domain restrictions rather than by
  secrecy.
* The SERVER must not inherit the browser's copy. The Rapport payload names the basemap the
  operator was looking at, and a keyed template in that payload would put the key into request
  bodies, application logs and the on-disk tile-cache filenames — three places it has no reason
  to be, on a machine that already holds the credential itself.

So the client sends the template UNKEYED (``withoutCartoBasemapKey``) and the server applies its
own credential here. Belt and braces: ``strip_key`` runs on the way in regardless, so an older
client that still sends a keyed template — or a station-authored custom layer with a key pasted
into it — cannot smuggle one into the cache key either.
"""

import re
from urllib.parse import quote

from .credentials import get as credential

#: The CARTO raster CDN, optionally on one of its a–d subdomains. Anything else is left alone:
#: swisstopo WMTS, a station's own tile server and a self-hosted style have no business
#: receiving this deployment's CARTO credential.
_CARTO_RASTER_HOST = re.compile(r"^https://(?:[a-d]\.)?basemaps\.cartocdn\.com/", re.IGNORECASE)


def is_carto(url: str) -> bool:
    """Is this a CARTO raster tile template?"""
    return bool(_CARTO_RASTER_HOST.match(url))


def strip_key(url: str) -> str:
    """Remove any ``key=`` parameter, leaving a template safe to log and to hash into a cache
    filename. Host-agnostic on purpose — a key does not become ours by sitting on another CDN,
    and a cache entry must never be split by a credential that can be rotated.

    ⚠️ Splits the query on its real separators rather than pattern-matching the URL: substring
    surgery is how ``monkey=1`` gets eaten. ``urlsplit`` is not used because the ``{z}/{x}/{y}``
    slots must survive verbatim.
    """
    base, sep, frag = url.partition("#")
    path, q, query = base.partition("?")
    if not q:
        return url
    kept = [p for p in query.split("&") if p and p != "key" and not p.startswith("key=")]
    return (f"{path}?{'&'.join(kept)}" if kept else path) + sep + frag


def with_key(url: str) -> str:
    """Apply THIS deployment's CARTO key to a CARTO raster template. A non-CARTO host, or no
    configured key, returns the URL untouched — an unkeyed CARTO request still answers, with the
    provider's watermarked tiles, so a station that has not set a key still gets a Rapport."""
    key = (credential("carto_api_key") or "").strip()
    if not key or not is_carto(url):
        return url
    return f"{url}{'&' if '?' in url else '?'}key={quote(key, safe='')}"


def for_fetch(url: str) -> tuple[str, str]:
    """``(fetch_url, cache_url)`` for one raster template.

    ``cache_url`` is the identity of the tile — no credential in it, so rotating the key does
    not orphan the cache and the cache filenames carry nothing secret. ``fetch_url`` is what
    actually goes to the CDN.
    """
    bare = strip_key(url)
    return with_key(bare), bare
