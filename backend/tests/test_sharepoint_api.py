"""The connector's two admin endpoints: who may read them, and what they say when it is off.

The status endpoint exists because this connector's most likely end is silence — an Azure
client secret expires, Graph answers 401, and nothing about the app looks different. So the
tests below are about a screen being able to tell the truth, including «nicht eingerichtet».
"""

import pytest
from sqlalchemy import select

from app import credentials as creds
from app.config import settings
from app.models import DeploymentConfig

pytestmark = pytest.mark.asyncio

SITE = "https://feuerwehr.sharepoint.com/sites/kp"


@pytest.fixture
def blank_env(monkeypatch):
    for f in creds.FIELDS:
        if f.declared:
            monkeypatch.setattr(settings, f.name, f.default, raising=False)
        else:
            monkeypatch.delenv(f.env, raising=False)
    creds.reset_cache()


async def test_the_status_is_admin_only(client):
    """Which folders a station reads and which app registration it holds are not editor
    business — the whole surface sits behind the deployment admin secret, like Zugangsdaten."""
    assert (await client.get("/api/sharepoint/status")).status_code in (401, 403)
    assert (await client.post("/api/sharepoint/sync")).status_code in (401, 403)


async def test_an_unconfigured_station_gets_a_state_rather_than_an_empty_card(client, admin_login, blank_env):
    await admin_login(client)
    body = (await client.get("/api/sharepoint/status")).json()
    assert body == {
        "configured": False,
        "credentials": False,
        "intervalMinutes": 60,
        "secretExpiresInDays": None,
        "areas": [],
    }


async def test_a_configured_station_lists_one_row_per_area_before_its_first_run(
    client, admin_login, blank_env, db_session
):
    """A row that has never run says `pending`, not «ok». A card that reports success for a
    sync that has not happened is the exact lie this surface exists to prevent."""
    db_session.add(
        DeploymentConfig(
            id=1,
            config_json={
                "sharepoint": {
                    "sources": [
                        {"area": "plans", "siteUrl": SITE, "path": "kp-data/plans"},
                        {"area": "workbook", "siteUrl": SITE, "path": "kp-data"},
                    ]
                }
            },
        )
    )
    await db_session.commit()
    await admin_login(client)

    body = (await client.get("/api/sharepoint/status")).json()

    assert [a["area"] for a in body["areas"]] == ["plans", "workbook"]
    assert {a["status"] for a in body["areas"]} == {"pending"}
    assert body["areas"][0]["path"] == "kp-data/plans"
    assert body["credentials"] is False and body["configured"] is False


async def test_the_secret_expiry_is_counted_down_and_the_secret_itself_never_appears(
    client, admin_login, blank_env, db_session
):
    """⚠️ The guaranteed failure two years in. The date is stored beside the secret precisely so
    the System card can warn WEEKS ahead instead of reporting an auth failure afterwards."""
    from datetime import UTC, datetime, timedelta

    await admin_login(client)
    secret = "a-client-secret-nobody-should-see"
    for name, value in (
        ("sharepoint_tenant_id", "11111111-1111-4111-8111-111111111111"),
        ("sharepoint_client_id", "22222222-2222-4222-8222-222222222222"),
        ("sharepoint_client_secret", secret),
        ("sharepoint_secret_expires", (datetime.now(UTC).date() + timedelta(days=30)).isoformat()),
    ):
        r = await client.put(f"/api/integrations/credentials/{name}", json={"value": value})
        assert r.status_code == 200, r.text

    body = (await client.get("/api/sharepoint/status")).json()
    assert body["secretExpiresInDays"] == 30
    assert body["credentials"] is True

    for path in ("/api/sharepoint/status", "/api/integrations/credentials", "/api/config", "/api/system"):
        assert secret not in (await client.get(path)).text, f"{path} leaked the client secret"


async def test_the_two_ids_are_readable_and_the_secret_is_not(client, admin_login, blank_env):
    """«Is this the right app registration?» is a question an operator answers against the Azure
    portal, so the ids are on the screen. Neither is usable without the secret, which is not."""
    await admin_login(client)
    await client.put(
        "/api/integrations/credentials/sharepoint_client_id",
        json={"value": "22222222-2222-4222-8222-222222222222"},
    )
    await client.put("/api/integrations/credentials/sharepoint_client_secret", json={"value": "a-secret-value"})

    rows = {c["name"]: c for c in (await client.get("/api/integrations/credentials")).json()}
    assert rows["sharepoint_client_id"]["value"] == "22222222-2222-4222-8222-222222222222"
    assert rows["sharepoint_client_secret"]["value"] is None
    assert rows["sharepoint_client_secret"]["configured"] is True
    assert rows["sharepoint_tenant_id"]["group"] == "sharepoint"


async def test_an_id_that_is_not_a_guid_is_refused_with_something_to_do_about_it(client, admin_login, blank_env):
    """The commonest paste here is the app's DISPLAY NAME. Refused at the box rather than as a
    400 from a token endpoint half an hour later, in a log nobody is reading."""
    await admin_login(client)
    r = await client.put("/api/integrations/credentials/sharepoint_tenant_id", json={"value": "Feuerwehr KP Front"})
    assert r.status_code == 422
    assert "GUID" in r.json()["detail"]

    r = await client.put("/api/integrations/credentials/sharepoint_secret_expires", json={"value": "31.03.2028"})
    assert r.status_code == 422
    assert "JJJJ-MM-TT" in r.json()["detail"]


async def test_running_the_sync_by_hand_answers_disabled_when_it_is_not_set_up(client, admin_login, blank_env):
    """The button has to be safe to press before anything is configured — an operator finding
    out what is wrong presses it first and reads the docs second."""
    await admin_login(client)
    r = await client.post("/api/sharepoint/sync")
    assert r.status_code == 200
    assert r.json() == {"status": "disabled", "areas": {}}


async def test_the_config_section_survives_a_save_through_the_api(client, admin_login, db_session):
    """⚠️ The trap this section is most likely to fall into: an undeclared block is dropped on
    the next round-trip, so a station would configure its folders, press save in /admin once,
    and find the connector quietly switched off."""
    await admin_login(client)
    document = {"sharepoint": {"intervalMinutes": 15, "sources": [{"area": "geodata", "siteUrl": SITE, "path": "gis"}]}}

    put = await client.put("/api/config", json=document)
    assert put.status_code == 200, put.text
    assert put.json()["sharepoint"]["sources"][0]["path"] == "gis"

    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    assert row.config_json["sharepoint"]["intervalMinutes"] == 15
