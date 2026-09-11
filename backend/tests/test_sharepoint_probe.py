"""«Verbindung testen» — a credential check an operator can run without waiting for the next
scheduled poll, and without importing anything.

Same fixture as test_sharepoint_sync.py (a whole fake tenant on `httpx.MockTransport`), because
the point of the probe is that it drives the SAME `GraphClient` the real pull does — nothing
about token acquisition or drive resolution is reimplemented for this endpoint.
"""

import httpx
import pytest
from sharepoint_fake import CLIENT_ID, CLIENT_SECRET, TENANT_ID, FakeTenant, source
from sqlalchemy import select

from app import credentials as creds
from app.api.sharepoint import sharepoint_probe
from app.config import settings
from app.models import DeploymentConfig

pytestmark = pytest.mark.asyncio


@pytest.fixture
def blank_env(monkeypatch):
    """A deployment whose `.env` names none of these — the state a fresh station is in."""
    for f in creds.FIELDS:
        if f.declared:
            monkeypatch.setattr(settings, f.name, f.default, raising=False)
        else:
            monkeypatch.delenv(f.env, raising=False)
    creds.reset_cache()


async def configure(db, sources: list[dict]) -> None:
    """Credentials + a `sharepoint.sources` list, the way an admin would set both."""
    for name, value in (
        ("sharepoint_tenant_id", TENANT_ID),
        ("sharepoint_client_id", CLIENT_ID),
        ("sharepoint_client_secret", CLIENT_SECRET),
    ):
        await creds.set_value(db, name, value, actor_id=None)
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    document = {"sharepoint": {"sources": sources}}
    if row is None:
        db.add(DeploymentConfig(id=1, config_json=document))
    else:
        row.config_json = {**(row.config_json or {}), **document}
    await db.flush()


async def test_no_credentials_is_answered_without_touching_the_network(db_session, blank_env):
    tenant = FakeTenant({})

    result = await sharepoint_probe(db_session, transport=tenant.transport)

    assert result == {"ok": False, "detail": "no SharePoint credentials stored"}
    assert tenant.seen == []


async def test_credentials_with_no_source_configured_is_just_a_token(db_session, blank_env):
    """No folder to check yet — the connector is inert either way, so acquiring the token is
    the whole answer (mirrors `sync_sharepoint`'s own `disabled` short-circuit)."""
    await configure(db_session, [])
    tenant = FakeTenant({})

    result = await sharepoint_probe(db_session, transport=tenant.transport)

    assert result == {"ok": True, "detail": None}
    assert any(u.endswith("/oauth2/v2.0/token") for u in tenant.seen)
    # Nothing beyond the token request — no site, drive or folder lookup with no source to check.
    assert not any("/sites/" in u or u.endswith("/root") for u in tenant.seen)


async def test_a_working_source_resolves_its_drive_root(db_session, blank_env):
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": b"%PDF-1.4"})

    result = await sharepoint_probe(db_session, transport=tenant.transport)

    assert result == {"ok": True, "detail": None}
    assert any(u.endswith("/root") for u in tenant.seen), (
        "the drive root is what a probe reads, not the configured folder"
    )


async def test_an_expired_client_secret_answers_with_azure_s_own_sentence(db_session, blank_env):
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": b"%PDF-1.4"})
    tenant.fail_auth()

    result = await sharepoint_probe(db_session, transport=tenant.transport)

    assert result["ok"] is False
    assert "AADSTS7000222" in (result["detail"] or "")


async def test_it_never_raises_on_an_unreachable_tenant(db_session, blank_env):
    """A tenant that answers nothing but errors is a `GraphError`, not a crash — the whole point
    of a probe is that a broken connector still gets an answer instead of a 500."""
    await configure(db_session, [source("plans")])
    refuse = httpx.MockTransport(lambda request: httpx.Response(503, json={"error": {"message": "tenant unreachable"}}))

    result = await sharepoint_probe(db_session, transport=refuse)

    assert result["ok"] is False
    assert result["detail"]
