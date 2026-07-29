"""Building outlines go through OUR backend, never from the browser to a third party.

The «Umrisse» surface used to POST the incident's bounding box straight from the browser to
three public Overpass mirrors — one of them hosted in Russia — while README.md promised
"every external service is proxied by the backend (the browser never calls a third party)"
and PRIVACY.md said the only outbound channels were the two it documented. The surface is
prefetched on every incident open, so this was the normal path, not an edge case.

Two things are pinned here:
- the proxy endpoint itself (auth, bbox validation, fail-closed when unconfigured), and
- that no third-party endpoint has crept back into the browser bundle, which is the part a
  future change is most likely to undo without anyone noticing.
"""

import re
from pathlib import Path

import pytest

from app.overpass import mirrors

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC = REPO_ROOT / "src"


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_requires_authentication(client):
    """Unauthenticated, this would be an open relay pointed at Overpass from our address."""
    r = await client.post(
        "/api/overpass/buildings",
        json={"south": 47.4, "west": 7.4, "north": 47.5, "east": 7.5},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_rejects_inverted_bbox(client, editor):
    """South above north is a client bug; answer 422 rather than asking Overpass."""
    await _login(client, editor)
    r = await client.post(
        "/api/overpass/buildings",
        json={"south": 47.5, "west": 7.4, "north": 47.4, "east": 7.5},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_rejects_out_of_range_coordinates(client, editor):
    """Latitude beyond the poles never reaches the mirror race."""
    await _login(client, editor)
    r = await client.post(
        "/api/overpass/buildings",
        json={"south": -95.0, "west": 7.4, "north": 47.5, "east": 7.5},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_unconfigured_is_fail_closed(client, editor, monkeypatch):
    """A station that empties the mirror list gets an honest 503, not a silent fallback."""
    from app import overpass

    monkeypatch.setattr(overpass, "mirrors", list)
    await _login(client, editor)
    r = await client.post(
        "/api/overpass/buildings",
        json={"south": 47.4, "west": 7.4, "north": 47.5, "east": 7.5},
    )
    assert r.status_code == 503


def test_only_https_mirrors_are_accepted(monkeypatch):
    """The https-only guard matches traccar.py / weather.py: config must not become a way to
    point the backend at an internal http:// address."""
    from app import overpass

    monkeypatch.setattr(
        overpass.settings,
        "overpass_mirrors",
        "http://internal.local/api,https://ok.example/api,ftp://nope/api",
        raising=False,
    )
    assert overpass.mirrors() == ["https://ok.example/api"]


def test_default_mirrors_are_all_https():
    """Whatever the shipped default list becomes, it must survive its own guard."""
    assert mirrors(), "default mirror list must not be empty"
    assert all(m.startswith("https://") for m in mirrors())


def test_browser_bundle_makes_no_direct_third_party_calls():
    """README's "the browser never calls a third party" has to stay true.

    Scans the frontend source for absolute http(s) URLs used as fetch targets. Comments,
    docs links and the tile/basemap URLs are excluded — basemap tiles are a documented,
    diagrammed exception that cannot be proxied without defeating browser tile caching.
    """
    offenders: list[str] = []
    allowed = re.compile(
        r"(basemaps|tile|swisstopo|geo\.admin\.ch|openstreetmap\.org/copyright|"
        r"github\.com|schema\.org|w3\.org)",
        re.I,
    )

    for path in SRC.rglob("*.ts*"):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith(("//", "*")):
                continue
            for match in re.finditer(r"fetch\(\s*['\"`](https?://[^'\"`]+)", line):
                url = match.group(1)
                if not allowed.search(url):
                    offenders.append(f"{path.relative_to(REPO_ROOT)}:{lineno} → {url}")

    assert not offenders, "browser calls a third party directly:\n" + "\n".join(offenders)
