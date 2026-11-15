"""«Alarm aktualisiert» (app/alarm_update): a Divera follow-up of an open Einsatz's own alarm.

Never applied by itself: it waits on the Einsatz until the crew takes it (only what they did not
edit by hand), edits it, or hides it for every device. Example data is invented.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.config import settings
from app.models import Incident, JournalEntry

HOOK = {"X-Webhook-Secret": "hook-secret-123"}
FIRST = {
    "id": 9001,
    "title": "Brand, Musterweg 12",
    "text": "Rauch aus Dachstock",
    "address": "Musterweg 12, 9999 Beispielstadt",
    "lat": 47.1,
    "lng": 8.1,
    "ts_create": 1_700_000_000,
    "ts_update": 1_700_000_000,
}


def _update(n: int, **changes) -> dict:
    return {**FIRST, "ts_update": FIRST["ts_update"] + n, **changes}


NEW_ADDR = {"address": "Musterweg 21, 9999 Beispielstadt", "lat": 47.2, "lng": 8.2}
NEW_TEXT = {"text": "Rauch aus Dachstock, Person vermisst"}


@pytest.fixture(autouse=True)
def webhook_secret(monkeypatch):
    monkeypatch.setattr(settings, "divera_webhook_secret", "hook-secret-123")


@pytest.fixture
async def opened(client, db_session, editor) -> Incident:
    """The alarm opened its Einsatz, and an editor has worked it since (`editor_opened_at`)."""
    r = await client.post("/api/divera/webhook", json=FIRST, headers=HOOK)
    inc = await db_session.get(Incident, r.json()["incident_id"])
    inc.editor_opened_at = datetime.now(UTC)
    await db_session.commit()
    assert (await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})).status_code == 200
    return inc


async def _send(client, payload: dict) -> None:
    assert (await client.post("/api/divera/webhook", json=payload, headers=HOOK)).status_code == 200


async def _served(client, inc: Incident) -> dict | None:
    """What every device's list poll sees."""
    row = next(i for i in (await client.get("/api/incidents")).json() if i["id"] == str(inc.id))
    return row["alarm_update"]


async def _verlauf(db_session, inc: Incident) -> list[str]:
    rows = (
        await db_session.execute(
            select(JournalEntry.row_json).where(JournalEntry.incident_id == inc.id).order_by(JournalEntry.seq)
        )
    ).scalars()
    return [r["text"] for r in rows]


async def test_an_update_waits_on_a_worked_einsatz_and_says_so_in_the_verlauf(client, db_session, opened):
    await _send(client, _update(1, **NEW_ADDR, **NEW_TEXT))

    served = await _served(client, opened)
    assert [(f["field"], f["current"], f["alarm"], f["edited"]) for f in served["fields"]] == [
        ("address", "Musterweg 12, 9999 Beispielstadt", "Musterweg 21, 9999 Beispielstadt", False),
        ("text", "Rauch aus Dachstock", "Rauch aus Dachstock, Person vermisst", False),
    ]
    # nothing was overwritten
    await db_session.refresh(opened)
    assert opened.address == FIRST["address"] and opened.text == FIRST["text"]
    assert await _verlauf(db_session, opened) == [
        "Alarm aktualisiert: Adresse Musterweg 12, 9999 Beispielstadt → Musterweg 21, 9999 Beispielstadt, "
        "Meldung ergänzt «Person vermisst»"
    ]
    # the poll sees the same stamp again on every round: nothing twice
    await _send(client, _update(1, **NEW_ADDR, **NEW_TEXT))
    assert len(await _verlauf(db_session, opened)) == 1


async def test_accept_takes_only_what_nobody_edited_by_hand(client, db_session, opened):
    r = await client.patch(f"/api/incidents/{opened.id}", json={"address": "Musterweg 14, 9999 Beispielstadt"})
    assert r.status_code == 200
    await _send(client, _update(1, **NEW_ADDR, **NEW_TEXT))
    assert [f["edited"] for f in (await _served(client, opened))["fields"]] == [True, False]

    r = await client.post(f"/api/incidents/{opened.id}/alarm-update/accept")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["address"] == "Musterweg 14, 9999 Beispielstadt"
    assert body["text"] == NEW_TEXT["text"]
    assert body["alarm_update"] is None
    assert (await _verlauf(db_session, opened))[-1] == "Alarm-Aktualisierung übernommen: Meldung (Adresse bleibt)"


async def test_accept_moves_the_pin_keeps_the_einsatzart_and_undo_brings_it_all_back(client, db_session, opened):
    await db_session.refresh(opened)
    type_before = opened.type
    await _send(client, _update(1, title="Explosion, Musterweg 21", **NEW_ADDR))

    body = (await client.post(f"/api/incidents/{opened.id}/alarm-update/accept")).json()
    assert (body["title"], body["address"], body["lat"], body["lng"]) == (
        "Explosion, Musterweg 21",
        NEW_ADDR["address"],
        NEW_ADDR["lat"],
        NEW_ADDR["lng"],
    )
    # a new title is title text only – the Einsatzart is not re-derived from it
    assert body["type"] == type_before

    body = (await client.post(f"/api/incidents/{opened.id}/alarm-update/undo")).json()
    assert (body["title"], body["address"], body["lat"]) == (FIRST["title"], FIRST["address"], FIRST["lat"])
    assert {f["field"] for f in body["alarm_update"]["fields"]} == {"address", "title"}


async def test_dismiss_hides_it_for_every_device(client, db_session, opened, viewer):
    await _send(client, _update(1, **NEW_TEXT))
    assert (await client.post(f"/api/incidents/{opened.id}/alarm-update/dismiss")).status_code == 200

    # another session (here a viewer) polls the list: the decision is the Einsatz's, not a device's
    await client.post("/api/auth/logout")
    assert (await client.post("/api/auth/login", json={"user_id": str(viewer.id), "pin": "135790"})).status_code == 200
    assert await _served(client, opened) is None
    assert (await _verlauf(db_session, opened))[-1] == "Alarm-Aktualisierung ausgeblendet"


async def test_a_later_update_replaces_the_pending_one(client, opened):
    await _send(client, _update(1, **NEW_TEXT))
    await _send(client, _update(2, **NEW_ADDR))

    # the row is the latest alarm against the Einsatz – the first update's text is gone with it
    assert [f["field"] for f in (await _served(client, opened))["fields"]] == ["address"]


async def test_an_update_identical_to_the_einsatz_makes_no_row(client, db_session, opened):
    await _send(client, _update(1))

    assert await _served(client, opened) is None
    assert await _verlauf(db_session, opened) == []
    # …and a hand edit afterwards does not turn that same update into one
    await client.patch(f"/api/incidents/{opened.id}", json={"text": "Rauch sichtbar"})
    await _send(client, _update(1))
    assert await _served(client, opened) is None
