"""The auto-alignment endpoint's seams that must hold WITHOUT the heavy CV deps.

Deliberately a separate file from test_georef_suggest.py: that one `importorskip`s the whole
`georef` extra, so the 503-fail-closed contract — the exact behavior of a production image
that ships without the extra — could never live there. These tests monkeypatch the lazy
import seam (`app.api.georef_suggest · _load_matcher`) instead of the environment.
"""

import pytest

from app import overpass, providers
from app.api import georef_suggest as api


@pytest.fixture
async def editor_client(client, editor):
    login = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert login.status_code == 200
    return client


async def test_unavailable_deps_answer_503_not_500(editor_client, monkeypatch):
    """Fail-closed: a deployment without the `georef` extra says so and the app degrades to
    the manual point flow — never a 500, never a hung stream."""

    def unavailable():
        raise ImportError("opencv not installed")

    monkeypatch.setattr(api, "_load_matcher", unavailable)
    response = await editor_client.post(
        "/api/georef/suggest",
        params={"lng": 7.5, "lat": 47.5, "mPerPx": 0.17, "template": "m2"},
        files={"image": ("plan.jpg", b"\xff\xd8\xff", "image/jpeg")},
    )
    assert response.status_code == 503
    assert "nicht installiert" in response.json()["detail"]


@pytest.mark.parametrize(
    "params",
    [
        {"lng": 7.5, "lat": 47.5, "mPerPx": 1.5, "template": "m2"},  # scale past every template
        {"lng": 7.5, "lat": 47.5, "mPerPx": 0.17, "template": "m9"},  # unknown template
        {"lng": 200.0, "lat": 47.5, "mPerPx": 0.17, "template": "m2"},  # off-planet
    ],
)
async def test_invalid_parameters_are_refused(editor_client, monkeypatch, params):
    # the parameter gate sits behind the import seam — stub it so this file needs no cv2
    monkeypatch.setattr(api, "_load_matcher", lambda: object())
    response = await editor_client.post(
        "/api/georef/suggest",
        params=params,
        files={"image": ("plan.jpg", b"\xff\xd8\xff", "image/jpeg")},
    )
    assert response.status_code == 422


# ── `integrations.autoAlignConfigured` — the 503 the surface must never reach ─────────────────
# Field report 09.09.2026: the production image ships without the `georef` extra, so every press
# of «Automatisch ausrichten» answered «…ist auf diesem Server nicht eingerichtet» — an
# affordance that cannot work and cannot be switched off. The public config now states the
# capability up front and the client hides the chooser (lib/georefSuggest · georefSuggestEligible).


async def test_auto_align_flag_is_false_without_the_extra(client, monkeypatch):
    monkeypatch.setattr(providers, "_GEOREF_MODULES", ("cv2", "kp_front_no_such_module"))
    cfg = await client.get("/api/config")
    assert cfg.json()["integrations"]["autoAlignConfigured"] is False


async def test_auto_align_flag_is_true_with_the_extra_and_a_mirror(client, monkeypatch):
    # a stand-in for the installed extra: what is under test is the find_spec gate, not cv2
    monkeypatch.setattr(providers, "_GEOREF_MODULES", ("json",))
    cfg = await client.get("/api/config")
    assert cfg.json()["integrations"]["autoAlignConfigured"] is True


async def test_auto_align_flag_is_false_without_an_overpass_mirror(client, monkeypatch):
    """The other 503 the endpoint fails closed on — the matcher has nothing to match against."""
    monkeypatch.setattr(providers, "_GEOREF_MODULES", ("json",))
    monkeypatch.setattr(overpass, "mirrors", list)
    cfg = await client.get("/api/config")
    assert cfg.json()["integrations"]["autoAlignConfigured"] is False


async def test_a_true_flag_means_the_matcher_really_imports(client):
    """⚠️ The drift guard. The flag probes the extra's top-level modules instead of importing
    the ~60 MB matcher on a public config read, so a new dependency in georef_suggest.py would
    otherwise make the flag promise something the endpoint still 503s on."""
    if not (await client.get("/api/config")).json()["integrations"]["autoAlignConfigured"]:
        pytest.skip("the georef extra is not installed in this environment")
    api._load_matcher()  # must not raise ImportError
