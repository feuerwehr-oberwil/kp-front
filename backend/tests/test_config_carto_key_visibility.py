"""Who may read `integrations.cartoBasemapKey` off `GET /api/config`.

The key is a BROWSER credential — CARTO wants it in every tile URL, and a domain restriction in
CARTO rather than secrecy is what stops it being used elsewhere. That is an argument for not
hiding it from the people who draw maps. It is not an argument for handing it to callers who
draw none: the only caller this endpoint serves before any session exists is the login screen,
and the login screen renders a Splash.

So: everyone with a session, nobody without. The key is on no public list
(`test_config_public_parts.py`); the incident-link case is in `test_incident_link.py`.
"""

import pytest

from app.schemas import ConfigIntegrations

pytestmark = pytest.mark.asyncio

KEY = "carto-browser-key"


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    """A station that HAS a key configured — otherwise every assertion below passes vacuously."""
    monkeypatch.setattr(
        "app.api.config.integrations",
        lambda: ConfigIntegrations(cartoBasemapKey=KEY, diveraConfigured=True, microsoftLoginConfigured=True),
    )


async def test_an_anonymous_caller_gets_no_key(client):
    r = await client.get("/api/config")
    assert KEY not in r.text
    # …and of the integrations block only the login screen's switch
    assert r.json()["integrations"] == {"microsoftLoginConfigured": True}


@pytest.mark.parametrize("role", ["editor", "el", "viewer"])
async def test_a_pin_session_gets_it_because_it_is_about_to_draw_a_map(client, db_session, role):
    from tests.conftest import _make_user

    user = await _make_user(db_session, username=f"u-{role}", role=role)
    assert (await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})).status_code == 200
    ints = (await client.get("/api/config")).json()["integrations"]
    assert ints["cartoBasemapKey"] == KEY
    assert ints["diveraConfigured"] is True
