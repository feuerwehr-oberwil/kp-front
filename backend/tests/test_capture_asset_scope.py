"""What a POSTER token may pull into a Rapport-PDF (SEC-06).

The capture surface authorises ONE incident per route (`_reachable_incident`) and then hands
the payload to the composer everybody shares. The composer's asset resolver looked media up by
UUID and reference plans by dataset id alone, so the incident the route authorised never
reached the place that actually opens files: a poster token that knows an archived incident's
photo id could name it as a Beilage of a permitted incident and get the bytes back inside a
PDF the capture API otherwise answers 404 for.

Contract under test:
- a capture rapport may embed media of the incident the route authorised — journal pictures
  and Beilagen alike;
- media of ANY other incident is refused (403), whether it arrives as a Beilage or as a
  journal `photoUrls` entry, and whether or not that incident is still reachable at all;
- reference plans are refused outright: the poster has no map and no Pläne by design
  (`CAPTURE_WORKSPACE_KEYS`), so a plan reference can only have been typed by a caller
  reaching past its own surface;
- a payload naming a different `incident.id` from the route is refused before anything is
  resolved — the route's authorisation is the authority, not the body;
- the print-queue twin shares the resolver and therefore shares the policy, and a refused
  print leaves no job behind;
- the logged-in report path is deliberately UNCHANGED: an ordinary user already reads the
  whole station, so scoping their own rapport would buy nothing and would break legitimate
  cross-incident Beilagen.
"""

import io
import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from PIL import Image as PILImage
from sqlalchemy import select

from app import storage
from app.models import DeploymentConfig, Incident, Media, PrintJob, ReferenceDataset

TOKEN = "poster-token-scope"
CH = {"X-Capture-Token": TOKEN}

#: The one refusal, for every way a payload can reach past the incident the route authorised.
OUT_OF_SCOPE_DETAIL = "Rapport enthält Inhalte ausserhalb dieses Einsatzes"


@pytest.fixture
async def capture_secret(db_session):
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db_session.add(row)
    row.capture_secret = TOKEN
    await db_session.commit()
    return TOKEN


def _png(w: int = 12, h: int = 8) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", (w, h), (200, 210, 220)).save(buf, "PNG")
    return buf.getvalue()


def _pdf() -> bytes:
    """A real one-page PDF, so the plan path is refused by the POLICY rather than by pdfium
    choking on garbage — a 500 would let this test pass for the wrong reason."""
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(60, 700, "Modul 1")
    c.showPage()
    c.save()
    return buf.getvalue()


async def _incident(db, **kw) -> Incident:
    base = {"title": "Wasser im Keller", "source": "manual", "status": "offen"}
    inc = Incident(**{**base, **kw})
    db.add(inc)
    await db.commit()
    await db.refresh(inc)
    return inc


async def _photo_on(db, incident_id) -> Media:
    """A media row whose bytes really exist — a resolver that skipped a missing file would make
    every one of these assertions pass without the scope check ever running."""
    key = storage.new_key("media", ".png")
    storage.put_bytes(key, _png())
    m = Media(incident_id=incident_id, kind="photo", storage_key=key, content_type="image/png")
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return m


async def _plan(db, dataset_id: str = "plan:obj-1:modul1") -> ReferenceDataset:
    key = storage.new_key("reference", ".pdf")
    storage.put_bytes(key, _pdf())
    ds = ReferenceDataset(id=dataset_id, kind="pdf", storage_key=key)
    db.add(ds)
    await db.commit()
    return ds


def _payload(inc_id, **extra) -> str:
    body: dict = {
        "incident": {"title": "Wasser im Keller", "id": str(inc_id)},
        "generatedAt": "05.09.2026 09:00",
    }
    body.update(extra)
    return json.dumps(body)


# --- the legitimate poster rapport, unchanged --------------------------------------------


async def test_capture_rapport_embeds_its_own_incidents_pictures(client, capture_secret, db_session):
    """The half that has to keep working: journal photo and Beilage of the very incident the
    poster is filling in."""
    inc = await _incident(db_session)
    mine = await _photo_on(db_session, inc.id)
    payload = _payload(
        inc.id,
        journal=[{"timeLabel": "09:02", "area": "Erfassung", "text": "Lage", "photoUrls": [f"/api/media/{mine.id}"]}],
        attachments=[{"url": f"/api/media/{mine.id}", "caption": "Schaden"}],
    )

    r = await client.post(f"/api/capture/incidents/{inc.id}/report/pdf", headers=CH, data={"payload": payload})
    assert r.status_code == 200, r.text
    assert r.content[:5] == b"%PDF-"


# --- SEC-06: the assets a poster token must not reach ------------------------------------


async def test_capture_rapport_refuses_an_archived_incidents_photo(client, capture_secret, db_session):
    """The reported finding. The capture API answers 404 for the archived incident itself, and
    used to answer 200 — with its picture inside the PDF — when the same id travelled as a
    Beilage of an incident the poster may reach."""
    inc = await _incident(db_session)
    archived = await _incident(db_session, title="Archiviert", is_archived=True)
    theirs = await _photo_on(db_session, archived.id)

    # the direct route really is shut, so the PDF path is the only way in
    assert (await client.get(f"/api/capture/incidents/{archived.id}/workspace", headers=CH)).status_code == 404

    r = await client.post(
        f"/api/capture/incidents/{inc.id}/report/pdf",
        headers=CH,
        data={"payload": _payload(inc.id, attachments=[{"url": f"/api/media/{theirs.id}"}])},
    )
    assert r.status_code == 403, f"an archived incident's photo was served through a permitted rapport: {r.text[:200]}"
    assert r.json()["detail"] == OUT_OF_SCOPE_DETAIL
    assert r.content[:5] != b"%PDF-"


async def test_capture_rapport_refuses_a_reachable_but_foreign_incidents_photo(client, capture_secret, db_session):
    """Not only the archived case: the rapport is OF one incident, so another incident's media
    has no business in it even when the poster could open that incident's own form."""
    inc = await _incident(db_session)
    other = await _incident(db_session, title="Nachbareinsatz")
    theirs = await _photo_on(db_session, other.id)
    assert (await client.get(f"/api/capture/incidents/{other.id}/workspace", headers=CH)).status_code == 200

    r = await client.post(
        f"/api/capture/incidents/{inc.id}/report/pdf",
        headers=CH,
        data={"payload": _payload(inc.id, attachments=[{"url": f"/api/media/{theirs.id}"}])},
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == OUT_OF_SCOPE_DETAIL


async def test_capture_rapport_refuses_a_foreign_photo_in_a_journal_row(client, capture_secret, db_session):
    """Beilagen are not the only door — the journal rows resolve through the same store."""
    inc = await _incident(db_session)
    other = await _incident(db_session, title="Nachbareinsatz")
    theirs = await _photo_on(db_session, other.id)

    r = await client.post(
        f"/api/capture/incidents/{inc.id}/report/pdf",
        headers=CH,
        data={
            "payload": _payload(
                inc.id,
                journal=[{"timeLabel": "09:02", "area": "x", "text": "y", "photoUrls": [f"/api/media/{theirs.id}"]}],
            )
        },
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == OUT_OF_SCOPE_DETAIL


async def test_capture_rapport_refuses_a_reference_plan(client, capture_secret, db_session):
    """The poster has no Pläne: `CAPTURE_WORKSPACE_KEYS` never hands it the board, and its own
    UI sends `plans: []`. A plan reference therefore cannot have come from the capture form."""
    inc = await _incident(db_session)
    ds = await _plan(db_session)

    r = await client.post(
        f"/api/capture/incidents/{inc.id}/report/pdf",
        headers=CH,
        data={"payload": _payload(inc.id, planPages=[{"label": "M1", "url": f"/api/reference/{ds.id}"}])},
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == OUT_OF_SCOPE_DETAIL


async def test_capture_rapport_refuses_a_payload_naming_another_incident(client, capture_secret, db_session):
    """The route's authorisation is the authority. A payload that says it is a different
    Einsatz is refused rather than quietly composed under the permitted one's name."""
    inc = await _incident(db_session)
    other = await _incident(db_session, title="Nachbareinsatz")

    r = await client.post(
        f"/api/capture/incidents/{inc.id}/report/pdf", headers=CH, data={"payload": _payload(other.id)}
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == OUT_OF_SCOPE_DETAIL


async def test_capture_rapport_still_accepts_a_payload_with_a_blank_incident_id(client, capture_secret, db_session):
    """A blank `incident.id` names no other Einsatz, so the conflict check has nothing to
    object to. Refusing it would break a draft composed before the id was known."""
    inc = await _incident(db_session)
    payload = json.dumps({"incident": {"title": "Wasser im Keller", "id": ""}, "generatedAt": "05.09.2026 09:00"})
    r = await client.post(f"/api/capture/incidents/{inc.id}/report/pdf", headers=CH, data={"payload": payload})
    assert r.status_code == 200, r.text


# --- the print-queue twin shares the resolver, so it shares the policy --------------------


@pytest.fixture
def relay_secret(monkeypatch):
    from app.api import print_relay
    from app.config import settings

    monkeypatch.setattr(settings, "print_agent_secret", "print-agent-secret-abc")
    monkeypatch.setattr(print_relay, "_last_seen", None)


async def test_capture_print_applies_the_same_policy(client, capture_secret, relay_secret, db_session):
    inc = await _incident(db_session)
    archived = await _incident(db_session, title="Archiviert", is_archived=True)
    theirs = await _photo_on(db_session, archived.id)

    r = await client.post(
        f"/api/capture/incidents/{inc.id}/report/print",
        headers=CH,
        data={"payload": _payload(inc.id, attachments=[{"url": f"/api/media/{theirs.id}"}])},
    )
    assert r.status_code == 403, f"the print queue composed what the download refuses: {r.text[:200]}"
    assert r.json()["detail"] == OUT_OF_SCOPE_DETAIL
    # …and nothing is left on the station printer's queue for an agent to pick up
    assert list((await db_session.execute(select(PrintJob))).scalars()) == []


async def test_capture_print_still_queues_its_own_incidents_rapport(client, capture_secret, relay_secret, db_session):
    inc = await _incident(db_session)
    mine = await _photo_on(db_session, inc.id)
    r = await client.post(
        f"/api/capture/incidents/{inc.id}/report/print",
        headers=CH,
        data={"payload": _payload(inc.id, attachments=[{"url": f"/api/media/{mine.id}"}])},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "queued"


# --- the boundary this fix deliberately does NOT move ------------------------------------


async def test_the_logged_in_report_path_is_unchanged(client, editor, db_session):
    """An ordinary session already reads every incident's media through /api/media, so
    narrowing its rapport would remove a legitimate cross-incident Beilage and add nothing.
    Pinned so a later «tighten everything» edit is a deliberate one."""
    inc = await _incident(db_session)
    other = await _incident(db_session, title="Nachbareinsatz", started_at=datetime.now(UTC) - timedelta(days=400))
    theirs = await _photo_on(db_session, other.id)

    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200, r.text

    r = await client.post(
        f"/api/incidents/{inc.id}/report/pdf",
        data={"payload": _payload(inc.id, attachments=[{"url": f"/api/media/{theirs.id}"}])},
    )
    assert r.status_code == 200, r.text
    assert r.content[:5] == b"%PDF-"


async def test_an_unknown_media_id_is_still_skipped_not_refused(client, capture_secret, db_session):
    """A rapport ships without a picture whose row is gone — «missing» is not «forbidden», and
    turning it into a 403 would break the Beilage somebody deleted mid-Erfassung."""
    inc = await _incident(db_session)
    r = await client.post(
        f"/api/capture/incidents/{inc.id}/report/pdf",
        headers=CH,
        data={"payload": _payload(inc.id, attachments=[{"url": f"/api/media/{uuid.uuid4()}"}])},
    )
    assert r.status_code == 200, r.text
    assert r.content[:5] == b"%PDF-"
