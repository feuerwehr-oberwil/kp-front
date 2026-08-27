"""Who may read `integrations.cartoBasemapKey` off `GET /api/config`.

The key is a BROWSER credential — CARTO wants it in every tile URL, and a domain restriction in
CARTO rather than secrecy is what stops it being used elsewhere. That is an argument for not
hiding it from the people who draw maps. It is not an argument for handing it to callers who
draw none: the only caller this endpoint serves before any session exists is the login screen,
and the login screen renders a Splash.

So it follows `report.links`: everyone with a session, nobody without.
"""

import pytest

from app.api.config import _projection
from app.schemas import ConfigIntegrations, DeploymentConfigIn

KEY = "carto-browser-key"


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    """A station that HAS a key configured — otherwise every assertion below passes vacuously."""
    monkeypatch.setattr("app.api.config.integrations", lambda: ConfigIntegrations(cartoBasemapKey=KEY))


def _key(**kw) -> str | None:
    return _projection(DeploymentConfigIn(), **kw).integrations.cartoBasemapKey


def test_an_anonymous_caller_gets_no_key():
    assert _key(include_carto=False) is None


def test_a_session_of_any_kind_gets_it_because_it_is_about_to_draw_a_map():
    assert _key(include_carto=True) == KEY


def test_the_withholding_does_not_announce_itself(monkeypatch):
    """`None`, not `""` — byte-identical to a station that configured no key at all, so the
    response never says «there is something here you are not being shown»."""
    hidden = _projection(DeploymentConfigIn(), include_carto=False).model_dump()
    monkeypatch.setattr("app.api.config.integrations", ConfigIntegrations)
    unconfigured = _projection(DeploymentConfigIn(), include_carto=True).model_dump()
    assert hidden == unconfigured


def test_withholding_the_key_touches_nothing_else_in_integrations(monkeypatch):
    """One field is dropped, not the block. The «nicht konfiguriert» badges on the login-adjacent
    surfaces read the same object and must survive."""
    monkeypatch.setattr(
        "app.api.config.integrations",
        lambda: ConfigIntegrations(cartoBasemapKey=KEY, diveraConfigured=True, sttConfigured=True),
    )
    ints = _projection(DeploymentConfigIn(), include_carto=False).integrations
    assert ints.cartoBasemapKey is None
    assert ints.diveraConfigured is True and ints.sttConfigured is True
