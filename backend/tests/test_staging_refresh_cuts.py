"""The staging refresh's cuts (scripts/railway-staging-cuts.sql), run against PostgreSQL.

Hunt 24.11.2026, ops-integrations F1: the refresh kept prod's archive destinations and the
``sharepoint_export`` write registration, so staging's scheduler could file into prod's SharePoint.
PostgreSQL only (jsonb): runs in CI, skipped on the local SQLite run."""

import json
import os
from pathlib import Path

import pytest
from sqlalchemy import select, text

from app import credentials as creds
from app.models import DeploymentConfig, IntegrationCredential
from tests.sharepoint_write_fake import CLIENT_ID, CLIENT_SECRET, TENANT_ID

CUTS = Path(__file__).resolve().parents[2] / "scripts" / "railway-staging-cuts.sql"

pytestmark = [
    pytest.mark.skipif(not CUTS.exists(), reason="repo root not available (running from the image)"),
    pytest.mark.skipif(not os.getenv("KPF_TEST_BASE_DATABASE_URL"), reason="jsonb: needs PostgreSQL (CI runs it)"),
]


async def test_the_cuts_take_the_archive_writer_and_its_destinations(db_session, engine):
    dest = {"id": "sp", "siteUrl": "https://example.sharepoint.com/sites/x"}
    db_session.add(
        DeploymentConfig(
            id=1,
            config_json={
                "identity": {"appName": "KP"},
                "incidentArchive": {"enabled": True, "destinations": [dest]},
                "objectVisits": {"enabled": True, "destinations": [dest]},
                "sharepoint": {"sources": [{"id": "feed"}]},
            },
        )
    )
    await db_session.commit()
    for name, value in (
        ("sharepoint_export_tenant_id", TENANT_ID),
        ("sharepoint_export_client_id", CLIENT_ID),
        ("sharepoint_export_client_secret", CLIENT_SECRET),
    ):
        await creds.set_value(db_session, name, value, actor_id=None)
    await db_session.commit()

    sql = CUTS.read_text().replace("__STAGING_APP_NAME__", json.dumps("KP Staging"))
    async with engine.connect() as conn:
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(sql)
    await db_session.execute(text("SET search_path = public"))

    db_session.expire_all()
    cfg = (await db_session.execute(select(DeploymentConfig.config_json))).scalar_one()
    assert cfg["incidentArchive"] == {"enabled": True, "destinations": []}
    assert cfg["objectVisits"] == {"enabled": True, "destinations": []}
    assert cfg["sharepoint"] == {"sources": [{"id": "feed"}]}  # the read-only feed stays
    assert cfg["identity"]["appName"] == "KP Staging"
    names = (await db_session.execute(select(IntegrationCredential.name))).scalars().all()
    assert not [n for n in names if n.startswith("sharepoint_export")]
