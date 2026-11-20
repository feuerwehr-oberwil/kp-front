"""What `GET /api/config` hands a caller WITHOUT a session: a fixed, short list (owner pick,
20.11.2026) — and nothing that is added to the document later.

Until then the route withheld five named sections and served the rest, so a new section was
public by default: the fleet, the radio channels, the alarm groups and the Kommandant's name
reached anybody who asked. `PUBLIC_PARTS` turns that round. The Erfassungs-Poster, which has no
session either, reads its own list with its token (`CAPTURE_PARTS`, `GET /api/capture/config`).
"""

import json
from pathlib import Path

import pytest
from sqlalchemy import select

from app.api import config as config_api
from app.api.config import CAPTURE_PARTS, PUBLIC_PARTS, pick_parts
from app.models import DeploymentConfig, Personnel
from app.schemas import ConfigIntegrations, DeploymentConfigOut, IdentityConfig
from tests.conftest import _make_user

pytestmark = pytest.mark.asyncio

#: The Musterdorf demo seed: a populated document, so «absent» below is never vacuous.
DEMO = json.loads((Path(__file__).resolve().parents[2] / "examples/demo-data/config.json").read_text())
POSTER = "poster-token-123"


def _paths(node: object, prefix: str = "") -> set[str]:
    """Every dotted path of a JSON object, cut where a listed part is reached whole."""
    out: set[str] = set()
    if not isinstance(node, dict):
        return {prefix}
    for key, value in node.items():
        path = f"{prefix}.{key}" if prefix else key
        out |= {path} if path in PUBLIC_PARTS or path in CAPTURE_PARTS else _paths(value, path)
    return out


@pytest.fixture
async def station(client, admin_login, put_config, monkeypatch):
    """The demo station, with every integration flag set — then signed out again."""
    monkeypatch.setattr(
        "app.api.config.integrations",
        lambda: ConfigIntegrations(
            diveraConfigured=True,
            traccarConfigured=True,
            sttConfigured=True,
            cartoBasemapKey="carto-browser-key",
            microsoftLoginConfigured=True,
        ),
    )
    await admin_login(client)
    r = await put_config(client, DEMO)
    assert r.status_code == 200, r.text
    client.cookies.clear()


async def test_the_list_is_the_seven_parts_the_owner_picked():
    """Pinned on purpose: opening one more part to everybody is an edit HERE too."""
    assert set(PUBLIC_PARTS) == {
        "identity.appName",
        "identity.shortName",
        "identity.locale",
        "identity.accentColor",
        "identity.assets",
        "identity.demoMode",  # one part with the note below: the demo switch
        "identity.demoNote",
        "integrations.microsoftLoginConfigured",
    }


async def test_a_caller_without_a_session_gets_the_list_and_nothing_else(client, station):
    r = await client.get("/api/config")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.pop("partial") is True
    assert _paths(body) == set(PUBLIC_PARTS)
    assert body["identity"]["appName"] == "Feuerwehr Musterdorf"
    assert body["identity"]["demoMode"] is True
    assert body["integrations"] == {"microsoftLoginConfigured": True}
    # the parts the finding named, by name: none of them is in the answer
    text = r.text
    for withheld in ("kommandant", "Brunner", "fleet", "doctrine", "roster", "alarms", "carto", "version"):
        assert withheld not in text, withheld


async def test_a_part_that_is_added_later_is_withheld_by_default(client, station, monkeypatch):
    """A new section, and a new field inside a section that is partly public. Neither is on the
    list, so neither reaches the caller — nobody has to remember to withhold it."""
    real = config_api._projection

    class Grown:
        def __init__(self, out: DeploymentConfigOut) -> None:
            self.out = out

        def model_dump(self, **kw) -> dict:
            doc = self.out.model_dump(**kw)
            doc["brandNewSection"] = {"keySafe": "Kasten 4"}
            doc["identity"]["brandNewField"] = "internal"
            doc["integrations"]["brandNewProvider"] = True
            return doc

    monkeypatch.setattr(config_api, "_projection", lambda doc, **kw: Grown(real(doc, **kw)))
    body = (await client.get("/api/config")).json()
    assert "brandNewSection" not in body
    assert "brandNewField" not in body["identity"]
    assert "brandNewProvider" not in body["integrations"]


async def test_every_part_of_the_schema_that_is_not_listed_is_absent(client, station):
    """The same rule read off the MODELS: whatever a section or field is called, an unlisted one
    is not in the answer. A field added to these models is covered without an edit here."""
    body = (await client.get("/api/config")).json()
    assert set(body) - {"partial"} <= {"identity", "integrations"} < set(DeploymentConfigOut.model_fields)
    for section, model in (("identity", IdentityConfig), ("integrations", ConfigIntegrations)):
        listed = {p.split(".")[1] for p in PUBLIC_PARTS if p.startswith(f"{section}.")}
        assert set(body[section]) == listed
        assert set(model.model_fields) - listed, "the model must hold unlisted fields, or this proves nothing"


async def test_pick_parts_leaves_out_what_the_document_does_not_hold():
    assert pick_parts({"identity": {"appName": "X"}}, PUBLIC_PARTS) == {"identity": {"appName": "X"}}
    assert pick_parts({"identity": None, "fleet": {"vehicles": [1]}}, PUBLIC_PARTS) == {}


@pytest.mark.parametrize("role", ["editor", "el", "viewer"])
async def test_a_pin_session_gets_the_document(client, db_session, station, role):
    user = await _make_user(db_session, username=f"u-{role}", role=role)
    assert (await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})).status_code == 200
    body = (await client.get("/api/config")).json()
    assert "partial" not in body  # a session's answer is the document, as before
    assert [v["id"] for v in body["fleet"]["vehicles"]] == [v["id"] for v in DEMO["fleet"]["vehicles"]]
    assert body["identity"]["kommandant"] == DEMO["identity"]["kommandant"]
    assert body["integrations"]["cartoBasemapKey"] == "carto-browser-key"
    assert body["version"]


async def test_the_admin_gets_the_document(client, admin_login, station):
    await admin_login(client)
    body = (await client.get("/api/config")).json()
    assert "partial" not in body  # a session's answer is the document, as before
    assert body["doctrine"]["defaultFunkkanal"] == DEMO["doctrine"]["defaultFunkkanal"]


# --- the Erfassungs-Poster -------------------------------------------------------------------


@pytest.fixture
async def poster(db_session, station):
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    row.capture_secret = POSTER
    await db_session.commit()


async def test_the_poster_reads_its_parts_with_its_token(client, poster):
    r = await client.get("/api/capture/config", headers={"X-Capture-Token": POSTER})
    assert r.status_code == 200, r.text
    body = r.json()
    assert _paths(body) == set(CAPTURE_PARTS)
    assert [v["id"] for v in body["fleet"]["vehicles"]] == [v["id"] for v in DEMO["fleet"]["vehicles"]]
    assert [g["id"] for g in body["alarms"]["groups"]] == [g["id"] for g in DEMO["alarms"]["groups"]]
    assert body["report"]["partnerOrgs"] == DEMO["report"]["partnerOrgs"]
    assert body["mittel"]["catalogue"] and body["roster"]["ranks"]
    # …and the rest of those sections stays behind a session
    assert "attributeLists" not in body["fleet"] and "webhooks" not in body["alarms"]
    assert "doctrine" not in body and "map" not in body


async def test_the_poster_parts_need_the_token(client, poster):
    assert (await client.get("/api/capture/config")).status_code == 401
    assert (await client.get("/api/capture/config?t=nope")).status_code == 401


async def test_the_poster_parts_are_off_without_a_poster_secret(client, station):
    assert (await client.get(f"/api/capture/config?t={POSTER}")).status_code == 403


async def test_the_poster_roster_carries_no_divera_id(client, db_session, poster):
    db_session.add(Personnel(display_name="Meier Anna", is_active=True, divera_id=4711, rank="wm"))
    await db_session.commit()
    r = await client.get("/api/capture/roster", headers={"X-Capture-Token": POSTER})
    assert r.status_code == 200, r.text
    [person] = r.json()
    assert set(person) == {"id", "display_name", "rank"}
    assert (person["display_name"], person["rank"]) == ("Meier Anna", "wm")
    assert "4711" not in r.text and "divera" not in r.text


# --- a signed-in device whose 8 h access cookie has run out --------------------------------


@pytest.fixture
async def refresh_only(client, db_session, station):
    """Signed in, then the access cookie is gone: what a tablet sends on its first request of
    the day. The refresh cookie is what is left."""
    user = await _make_user(db_session, username="fu-device", role="editor")
    assert (await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})).status_code == 200
    client.cookies.delete("access_token")
    assert client.cookies.get("refresh_token")
    return user


async def test_a_device_with_only_its_refresh_cookie_still_gets_its_station(client, refresh_only):
    """`/api/config` never answers 401, so nothing renews the session before the boot read. Read
    as «nobody», the tablet would get the public list in place of its fleet and map layers."""
    body = (await client.get("/api/config")).json()
    assert "partial" not in body
    assert body["fleet"]["vehicles"] and body["identity"]["kommandant"]
    # …and the read consumed nothing: the same cookie still renews the session afterwards
    assert (await client.post("/api/auth/refresh")).status_code == 200


async def test_a_refresh_cookie_of_a_revoked_session_is_nobody(client, db_session, refresh_only):
    refresh_only.auth_generation += 1  # what a PIN reset or a deactivation does
    await db_session.commit()
    assert (await client.get("/api/config")).json().get("partial") is True


async def test_a_refresh_cookie_of_an_inactive_account_is_nobody(client, db_session, refresh_only):
    refresh_only.is_active = False
    await db_session.commit()
    assert (await client.get("/api/config")).json().get("partial") is True


async def test_a_signed_out_device_is_nobody(client, refresh_only):
    """Logout revokes the refresh token; a copy of the cookie kept from before is worth nothing."""
    kept = client.cookies.get("refresh_token")
    assert (await client.post("/api/auth/logout")).status_code in (200, 204)
    client.cookies.set("refresh_token", kept)
    assert (await client.get("/api/config")).json().get("partial") is True


async def test_an_access_cookie_is_not_accepted_in_the_refresh_slot(client, db_session, station):
    user = await _make_user(db_session, username="fu-swap", role="editor")
    assert (await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})).status_code == 200
    access = client.cookies.get("access_token")
    client.cookies.clear()
    client.cookies.set("refresh_token", access)
    assert (await client.get("/api/config")).json().get("partial") is True


async def test_a_link_page_that_speaks_for_itself_is_never_the_device_login(client, refresh_only):
    body = (await client.get("/api/config", headers={"X-Incident-Link": "use"})).json()
    assert body.get("partial") is True
