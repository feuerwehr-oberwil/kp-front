"""Who may read the server-side destinations off `GET /api/config` (RBAC audit S3, 22.10.2026).

`alarms.webhooks` (often capability URLs: a Power Automate `sig=`, a Teams hook, a `?secret=`)
and `sharepoint.sources` are addresses the SERVER talks to; no client but /admin reads them, so
only an admin session gets them. `objectVisits.destinations` is read by the signed-in app (the
Objektbesuch's «Ablage» line), so it follows `report.links`: every PIN session, nobody without.
"""

import pytest

from tests.conftest import _make_user

pytestmark = pytest.mark.asyncio

HOOK = "https://prod-00.westeurope.logic.azure.com/workflows/abc/triggers/manual?sig=SECRETSIG"
SITE = "https://contoso.sharepoint.com/sites/feuerwehr"
DOC = {
    "alarms": {"webhooks": [HOOK]},
    "sharepoint": {"sources": [{"area": "plans", "siteUrl": SITE}]},
    "objectVisits": {"destinations": [{"id": "sp", "siteUrl": SITE, "root": "Objekte"}]},
}


@pytest.fixture
async def configured(client, admin_login, put_config):
    await admin_login(client)
    r = await put_config(client, DOC)
    assert r.status_code == 200, r.text
    client.cookies.clear()


def _shown(cfg: dict) -> tuple[list, list, list]:
    return cfg["alarms"]["webhooks"], cfg["sharepoint"]["sources"], cfg["objectVisits"]["destinations"]


async def test_anonymous_gets_none_of_them(client, configured):
    assert _shown((await client.get("/api/config")).json()) == ([], [], [])


@pytest.mark.parametrize("role", ["editor", "el", "viewer"])
async def test_a_pin_session_gets_only_the_filing_destinations(client, db_session, configured, role):
    user = await _make_user(db_session, username=f"u-{role}", role=role)
    assert (await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})).status_code == 200
    hooks, sources, destinations = _shown((await client.get("/api/config")).json())
    assert hooks == [] and sources == []
    assert [d["id"] for d in destinations] == ["sp"]


async def test_the_admin_gets_everything_or_its_next_save_would_delete_them(client, admin_login, configured):
    await admin_login(client)
    hooks, sources, destinations = _shown((await client.get("/api/config")).json())
    assert hooks == [HOOK]
    assert [s["siteUrl"] for s in sources] == [SITE]
    assert [d["siteUrl"] for d in destinations] == [SITE]
