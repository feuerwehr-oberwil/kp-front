"""Server-side CARTO key handling (app/carto.py).

The browser needs the key in every tile URL; this machine does not need the browser's copy of
it. These tests pin the two properties that follow: the key never reaches a cache filename, and
a template that arrives keyed anyway is normalized before it does.
"""

import app.carto as carto

TPL = "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"


def test_only_carto_hosts_receive_this_deployments_key(monkeypatch):
    monkeypatch.setattr(carto, "credential", lambda name: "k1")
    assert carto.with_key(TPL) == f"{TPL}?key=k1"
    # swisstopo, a station's own tile server, anything else: not ours to credential
    other = "https://wmts.geo.admin.ch/1.0.0/x/default/current/3857/{z}/{x}/{y}.jpeg"
    assert carto.with_key(other) == other


def test_no_configured_key_still_renders_a_rapport(monkeypatch):
    """Unkeyed CARTO answers with watermarked tiles. A station that never set a key gets a
    Rapport with a watermark, not a Rapport with a grey rectangle."""
    monkeypatch.setattr(carto, "credential", lambda name: "")
    assert carto.with_key(TPL) == TPL


def test_the_key_is_url_encoded(monkeypatch):
    """A credential with `&` or `=` in it would otherwise forge extra query parameters."""
    monkeypatch.setattr(carto, "credential", lambda name: "a&b=c/+")
    assert carto.with_key(TPL) == f"{TPL}?key=a%26b%3Dc%2F%2B"


def test_strip_key_leaves_every_other_parameter_intact():
    assert carto.strip_key(f"{TPL}?key=secret") == TPL
    assert carto.strip_key(f"{TPL}?v=2&key=secret&lang=de") == f"{TPL}?v=2&lang=de"
    # the key came first, so removing it takes the `?` with it — the survivor needs it back
    assert carto.strip_key(f"{TPL}?key=secret&v=2") == f"{TPL}?v=2"
    assert carto.strip_key(TPL) == TPL
    # «monkey=1» is not a key parameter; a substring match would eat it
    assert carto.strip_key(f"{TPL}?monkey=1") == f"{TPL}?monkey=1"
    assert carto.strip_key(f"{TPL}?key=secret#frag") == f"{TPL}#frag"


def test_the_cache_identity_never_carries_a_credential(monkeypatch):
    """The on-disk cache hashes the URL into a filename. Keying the cache on the credential
    would put it in a filename AND orphan the whole cache on the next key rotation."""
    monkeypatch.setattr(carto, "credential", lambda name: "k1")
    fetch, cache = carto.for_fetch(TPL)
    assert fetch == f"{TPL}?key=k1"
    assert cache == TPL

    monkeypatch.setattr(carto, "credential", lambda name: "k2-after-rotation")
    fetch2, cache2 = carto.for_fetch(TPL)
    assert cache2 == cache, "a rotated key must not orphan the tile cache"
    assert fetch2 != fetch


def test_a_client_supplied_key_is_replaced_not_appended(monkeypatch):
    """Belt and braces for an older client (or a station layer with a key pasted into it):
    whatever arrives is stripped first, so exactly one key ever reaches the CDN — ours."""
    monkeypatch.setattr(carto, "credential", lambda name: "ours")
    fetch, cache = carto.for_fetch(f"{TPL}?key=theirs")
    assert fetch == f"{TPL}?key=ours"
    assert "theirs" not in fetch and "theirs" not in cache
