"""The auto-alignment endpoint's seams that must hold WITHOUT the heavy CV deps.

Deliberately a separate file from test_georef_suggest.py: that one `importorskip`s the whole
`georef` extra, so the 503-fail-closed contract — the exact behavior of a production image
that ships without the extra — could never live there. These tests monkeypatch the lazy
import seam (`app.api.georef_suggest · _load_matcher`) instead of the environment.
"""

import pytest

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
