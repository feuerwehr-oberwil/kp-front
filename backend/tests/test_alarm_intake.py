"""Generic alarm intake (POST /api/alarms), Divera auto-open, auto-archive sweep.

The intake endpoint is the auto-open path for non-Divera alerting systems, so the
fail-closed contract mirrors the Divera webhook:
- no ALARM_WEBHOOK_SECRET configured → 403 (endpoint disabled);
- configured + wrong/missing secret → 401;
- configured + correct secret → an auto-opened incident, idempotent on (source, source_id).

Divera auto-open is no longer configurable (2026-08-02): a NEW pool alarm becomes an
incident with no human in the loop, always, and the pool row is marked taken. The one
remaining «no» is the split-dispatch guard. The sweep archives only auto-opened incidents
nobody ever touched.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.alarms import auto_archive_sweep
from app.config import settings
from app.models import DeploymentConfig, DiveraEmergency, Incident

PAYLOAD = {
    "source": "leitstelle",
    "source_id": "E-2026-0815",
    "title": "BMA Alarm Industriestrasse",
    "address": "Industriestrasse 5",
}


@pytest.fixture
def alarm_secret(monkeypatch):
    monkeypatch.setattr(settings, "alarm_webhook_secret", "alarm-secret-123")


async def _set_alarms_config(db, cfg: dict) -> None:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json={"alarms": cfg})
        db.add(row)
    else:
        row.config_json = {**(row.config_json or {}), "alarms": cfg}
    await db.commit()


# --- generic intake -----------------------------------------------------------------


async def test_intake_fails_closed_without_configured_secret(client, monkeypatch):
    monkeypatch.setattr(settings, "alarm_webhook_secret", "")
    r = await client.post("/api/alarms", json=PAYLOAD)
    assert r.status_code == 403


async def test_intake_rejects_missing_or_wrong_secret(client, alarm_secret):
    r = await client.post("/api/alarms", json=PAYLOAD)
    assert r.status_code == 401
    r = await client.post("/api/alarms", json=PAYLOAD, headers={"X-Webhook-Secret": "nope"})
    assert r.status_code == 401


async def test_intake_creates_auto_opened_incident(client, alarm_secret, db_session):
    r = await client.post("/api/alarms?secret=alarm-secret-123", json=PAYLOAD)
    assert r.status_code == 201
    body = r.json()
    assert body["created"] is True

    inc = (
        await db_session.execute(
            select(Incident).where(Incident.source == "leitstelle", Incident.source_ref == "E-2026-0815")
        )
    ).scalar_one()
    assert str(inc.id) == body["incident_id"]
    assert inc.auto_opened is True
    assert inc.created_by is None
    # keyword inference kicked in (sender provided neither type nor priority)
    assert inc.type == "BMA / unechte Alarme"
    assert inc.priority == "HIGH"


async def test_intake_is_idempotent_on_source_id(client, alarm_secret, db_session):
    r1 = await client.post("/api/alarms?secret=alarm-secret-123", json=PAYLOAD)
    assert r1.status_code == 201
    r2 = await client.post("/api/alarms?secret=alarm-secret-123", json=PAYLOAD)
    assert r2.status_code == 200
    assert r2.json() == {"incident_id": r1.json()["incident_id"], "created": False}
    n = (await db_session.execute(select(Incident))).scalars().all()
    assert len(n) == 1


async def test_intake_accepts_kp_ruecks_payload(client, alarm_secret, db_session):
    """One payload has to work against both apps.

    `POST /api/alarms` exists in KP Front and KP Rück with the same path and purpose and
    took incompatible payloads: `source_id` was REQUIRED here and optional there, and
    `number` was accepted there and rejected here. A relay written against KP Rück got a
    422 from this endpoint, while the reserved-slug lists were carefully kept in sync — so
    it looked unified and was not.
    """
    payload = {"source": "leitstelle", "title": "BMA Alarm Industriestrasse", "number": "E-501"}
    r = await client.post("/api/alarms?secret=alarm-secret-123", json=payload)
    assert r.status_code == 201, r.text

    incidents = (await db_session.execute(select(Incident))).scalars().all()
    assert len(incidents) == 1
    # `number` has no field on an Einsatz here — accepted for payload compatibility and
    # ignored, deliberately, rather than rejected.
    assert incidents[0].source_ref is None


async def test_intake_without_source_id_cannot_dedupe_and_says_so_by_creating_two(client, alarm_secret, db_session):
    """No id to dedupe on means no dedupe — not "dedupe against everything from this source".

    Matching on a NULL source_ref would have collapsed every id-less alarm from one sender
    into the first one ever received, which is far worse than a duplicate: the second real
    alarm of the night would silently return the first one's incident.
    """
    payload = {"source": "leitstelle", "title": "Wasser im Keller"}
    r1 = await client.post("/api/alarms?secret=alarm-secret-123", json=payload)
    r2 = await client.post("/api/alarms?secret=alarm-secret-123", json=payload)
    assert r1.status_code == 201
    assert r2.status_code == 201
    assert r1.json()["incident_id"] != r2.json()["incident_id"]
    assert len((await db_session.execute(select(Incident))).scalars().all()) == 2


async def test_zero_coordinates_mean_no_location():
    """Divera sends lat/lng 0/0 for alarms without a location («Einrücken ins Magazin») —
    stored verbatim it centred map + weather on Null Island (nearest Swiss station:
    Grosser St. Bernhard). The payload validator and the intake guard both null it."""
    from app.schemas import DiveraWebhookPayload

    p = DiveraWebhookPayload(id=1, title="Einrücken ins Magazin", lat=0.0, lng=0.0)
    assert p.lat is None and p.lng is None
    # a real coordinate survives untouched
    p2 = DiveraWebhookPayload(id=2, title="Brand", lat=47.52, lng=7.57)
    assert p2.lat == 47.52 and p2.lng == 7.57


async def test_intake_zero_coordinate_falls_back_to_geocoder(client, alarm_secret, db_session, monkeypatch):
    """create_incident_from_alarm treats 0/0 as absent, so the address geocoder runs."""
    import app.alarms as alarms_mod

    async def fake_geocode(_addr):
        return (47.524, 7.570)

    monkeypatch.setattr(alarms_mod, "geocode", fake_geocode)
    payload = {**PAYLOAD, "source_id": "E-2026-0999", "lat": 0.0, "lng": 0.0, "address": "Bachweg 17, Musterdorf"}
    r = await client.post("/api/alarms?secret=alarm-secret-123", json=payload)
    assert r.status_code == 201
    inc = (await db_session.execute(select(Incident).where(Incident.source_ref == "E-2026-0999"))).scalar_one()
    assert float(inc.lat) == 47.524
    assert float(inc.lng) == 7.570


async def test_intake_rejects_reserved_sources(client, alarm_secret):
    # The full union with kp-rueck's list, not just Front's own three — see the comment on
    # RESERVED_ALARM_SOURCES. "intake", "operator" and "training" are Rück's; rejecting them
    # here is what makes one dispatch integration portable between the two apps.
    for source in ("manual", "migrated", "divera", "intake", "operator", "training"):
        r = await client.post("/api/alarms?secret=alarm-secret-123", json={**PAYLOAD, "source": source})
        assert r.status_code == 422


# --- Divera auto-open ----------------------------------------------------------------

DIVERA_PAYLOAD = {"id": 4712, "title": "Brand Dachstock", "address": "Teststrasse 2"}


@pytest.fixture
def webhook_secret(monkeypatch):
    monkeypatch.setattr(settings, "divera_webhook_secret", "hook-secret-123")


async def test_divera_webhook_opens_the_incident(client, webhook_secret, db_session):
    """No config, no flag: the alarm arrives and the Einsatz exists."""
    r = await client.post("/api/divera/webhook", json=DIVERA_PAYLOAD, headers={"X-Webhook-Secret": "hook-secret-123"})
    assert r.status_code == 200
    body = r.json()
    assert body["new"] is True
    assert body["incident_id"] is not None

    inc = (await db_session.execute(select(Incident).where(Incident.divera_id == 4712))).scalar_one()
    assert inc.auto_opened is True
    assert inc.source == "divera"
    # …and it is UNCONFIRMED until an editor opens it — nobody has attended anything yet
    assert inc.editor_opened_at is None
    em = (await db_session.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == 4712))).scalar_one()
    assert em.is_taken is True
    assert em.taken_incident_id == inc.id


async def test_divera_auto_open_ignores_the_retired_config_flags(client, webhook_secret, db_session):
    """`autoOpen: false` and the keyword/priority filters are accepted and ignored. A station
    that never opted in must not keep its Einsatz-Link holders staring at «nicht verfügbar»
    after the upgrade — that is the failure this change exists to end."""
    await _set_alarms_config(db_session, {"autoOpen": False, "autoOpenPriorities": ["HIGH"]})
    # "Dienstleistung" infers LOW — under the old filter this pooled and waited for a human
    r = await client.post(
        "/api/divera/webhook",
        json={"id": 4713, "title": "Dienstleistung Verkehrsdienst"},
        headers={"X-Webhook-Secret": "hook-secret-123"},
    )
    assert r.status_code == 200
    assert r.json()["incident_id"] is not None
    em = (await db_session.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == 4713))).scalar_one()
    assert em.is_taken is True


async def test_divera_auto_open_suppressed_while_incident_running(client, webhook_secret, db_session):
    """Split-dispatch guard: with an Einsatz running, a new alarm pools instead of
    auto-opening a duplicate (real split dispatch, 2026-07-15). With the take gone this is
    the ONLY thing left between a Nachalarm and a second incident — the EL attaches it."""
    running = Incident(
        title="Verunreinigung Bachweg",
        source="divera",
        status="offen",
        started_at=datetime.now(UTC) - timedelta(minutes=10),
    )
    db_session.add(running)
    await db_session.commit()

    r = await client.post(
        "/api/divera/webhook",
        json={"id": 4714, "title": "Brand Dachstock, Nachalarm"},
        headers={"X-Webhook-Secret": "hook-secret-123"},
    )
    assert r.status_code == 200
    assert r.json()["incident_id"] is None  # pooled, not opened
    em = (await db_session.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == 4714))).scalar_one()
    assert em.is_taken is False
    # the point of the guard: still ONE Einsatz, not the running one plus a Nachalarm twin
    assert [i.title for i in (await db_session.execute(select(Incident))).scalars()] == ["Verunreinigung Bachweg"]


async def test_divera_auto_open_ignores_stale_open_incident(client, webhook_secret, db_session):
    """An open incident older than the 4h running window (unfinished rapport) must not
    suppress auto-open for a genuinely new alarm."""
    stale = Incident(
        title="Alter Einsatz", source="manual", status="offen", started_at=datetime.now(UTC) - timedelta(hours=6)
    )
    db_session.add(stale)
    await db_session.commit()

    r = await client.post("/api/divera/webhook", json=DIVERA_PAYLOAD, headers={"X-Webhook-Secret": "hook-secret-123"})
    assert r.status_code == 200
    assert r.json()["incident_id"] is not None


# --- report_done_at (Abschluss-Assistent completion bookmark) --------------------------


async def test_report_done_patch_self_documents(client, editor):
    lr = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert lr.status_code == 200
    r = await client.post("/api/incidents", json={"title": "Kleinereignis"})
    assert r.status_code == 201
    iid = r.json()["id"]

    r = await client.patch(f"/api/incidents/{iid}", json={"report_done_at": "2026-07-08T12:00:00Z"})
    assert r.status_code == 200
    assert r.json()["report_done_at"] is not None

    jr = await client.get(f"/api/incidents/{iid}/journal")
    assert jr.status_code == 200
    texts = [e["row"]["text"] for e in jr.json()["entries"]]
    assert "Rapport abgeschlossen" in texts

    # re-completion after corrections self-documents as a replacing version
    r = await client.patch(f"/api/incidents/{iid}", json={"report_done_at": "2026-07-08T14:00:00Z"})
    assert r.status_code == 200
    jr = await client.get(f"/api/incidents/{iid}/journal")
    texts = [e["row"]["text"] for e in jr.json()["entries"]]
    assert any("erneut abgeschlossen" in t for t in texts)


# --- auto-archive sweep ---------------------------------------------------------------


def _incident(**kw) -> Incident:
    base = {"title": "Alt", "source": "leitstelle", "status": "offen"}
    return Incident(**{**base, **kw})


async def test_sweep_archives_only_untouched_auto_opened(db_session):
    await _set_alarms_config(db_session, {"autoArchiveDays": 7})
    old = datetime.now(UTC) - timedelta(days=8)
    fresh = datetime.now(UTC) - timedelta(days=1)
    swept = _incident(auto_opened=True, workspace_rev=0, started_at=old, source_ref="a1")
    touched = _incident(auto_opened=True, workspace_rev=3, started_at=old, source_ref="a2")
    manual = _incident(auto_opened=False, workspace_rev=0, started_at=old, source="manual")
    recent = _incident(auto_opened=True, workspace_rev=0, started_at=fresh, source_ref="a3")
    db_session.add_all([swept, touched, manual, recent])
    await db_session.commit()

    n = await auto_archive_sweep(db_session)
    await db_session.commit()
    assert n == 1
    await db_session.refresh(swept)
    assert swept.is_archived is True
    assert swept.closed_at is not None
    for inc in (touched, manual, recent):
        await db_session.refresh(inc)
        assert inc.is_archived is False


async def test_sweep_disabled_at_zero_days(db_session):
    await _set_alarms_config(db_session, {"autoArchiveDays": 0})
    old = datetime.now(UTC) - timedelta(days=30)
    db_session.add(_incident(auto_opened=True, workspace_rev=0, started_at=old, source_ref="z1"))
    await db_session.commit()
    assert await auto_archive_sweep(db_session) == 0
