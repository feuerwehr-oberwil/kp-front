"""The photo a Rückmeldung may carry — the caps, and the report that carries none.

Two halves, and the second one is the one that would go unnoticed if it broke. The caps are
easy to reason about and easy to test. The regression is not: every ordinary Rückmeldung —
which is nearly all of them — must put exactly the payload on the wire that it did before
photos existed, because a feature almost nobody uses has no business showing up in everybody's
queue row. So the no-photo case is asserted key by key, against the shape the endpoint has had
since it was written.

The caps themselves are not a nicety. The photo travels base64 inside ONE telemetry event, and
an event has a size an ingest will accept — see app/telemetry/photos.py for the arithmetic. A
cap that let two large photos through would not produce a big report, it would produce a report
that is refused upstream after the send button said it worked.
"""

import base64
import logging

import pytest
from sqlalchemy import select

from app.config import settings
from app.models import TelemetryOutbox
from app.telemetry import photos as photos_mod


def _jpeg(size: int) -> bytes:
    """`size` bytes that sniff as a JPEG."""
    return b"\xff\xd8\xff" + b"\x00" * (size - 3)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


@pytest.fixture(autouse=True)
def _usable_dsn(monkeypatch):
    monkeypatch.setattr(settings, "telemetry_dsn", "https://pub1ickey@ingest.test/1")
    monkeypatch.setattr(settings, "telemetry_enabled", True)


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200, r.text


# --- prepare_photos, on its own --------------------------------------------------------


def test_a_photo_at_the_cap_is_kept():
    out = photos_mod.prepare_photos([_b64(_jpeg(photos_mod.MAX_PHOTO_BYTES))])
    assert len(out) == 1
    assert out[0]["mime"] == "image/jpeg"
    assert out[0]["bytes"] == photos_mod.MAX_PHOTO_BYTES


def test_one_byte_over_the_cap_is_dropped():
    assert photos_mod.prepare_photos([_b64(_jpeg(photos_mod.MAX_PHOTO_BYTES + 1))]) == []


def test_only_the_first_two_are_kept():
    three = [_b64(_jpeg(100)) for _ in range(3)]
    assert len(photos_mod.prepare_photos(three)) == photos_mod.MAX_PHOTOS


def test_the_mime_comes_from_the_bytes_not_from_a_label():
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
    webp = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 40
    assert [p["mime"] for p in photos_mod.prepare_photos([_b64(png), _b64(webp)])] == [
        "image/png",
        "image/webp",
    ]


def test_something_that_is_not_a_picture_is_dropped():
    # A PDF, a zip, a text file — nothing here can scrub it, so nothing here forwards it.
    assert photos_mod.prepare_photos([_b64(b"%PDF-1.7 not a picture at all")]) == []


def test_garbage_is_dropped_rather_than_raised():
    # A malformed attachment must not cost the operator the sentences they typed.
    assert photos_mod.prepare_photos(["not base64 at all !!", ""]) == []


def test_attach_is_a_no_op_without_photos():
    event = {"tags": {"channel": "report"}}
    photos_mod.attach(event, [])
    assert event == {"tags": {"channel": "report"}}


def test_the_echo_drops_the_bytes_but_keeps_the_count_and_the_size():
    event = {"tags": {}, "extra": {"troubleAt": "x"}}
    photos_mod.attach(event, photos_mod.prepare_photos([_b64(_jpeg(4000))]))
    echo = photos_mod.summarise_for_echo(event)

    assert echo["extra"]["photos"] == [{"mime": "image/jpeg", "bytes": 4000}]
    assert echo["extra"]["troubleAt"] == "x"
    # …and the queued event still has the real thing: the echo is a view, not a redaction.
    assert "data" in event["extra"]["photos"][0]


def test_the_echo_leaves_a_photoless_event_exactly_alone():
    event = {"tags": {"channel": "report"}, "message": {"formatted": "kaputt"}}
    assert photos_mod.summarise_for_echo(event) is event


# --- Through the endpoint --------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_report_without_photos_is_unchanged(client, db_session, editor):
    """The regression guard. This is the payload nearly every Rückmeldung produces."""
    await _login(client, editor)
    r = await client.post("/api/diag/report", json={"message": "Bildschirm war weiss"})
    assert r.status_code == 202

    row = (await db_session.execute(select(TelemetryOutbox))).scalars().one()
    payload = row.payload_json
    # No photo key anywhere, and no `extra` invented to hold one: an event without a trouble
    # timestamp has never had an `extra` block and must still not have one.
    assert "photos" not in payload.get("tags", {})
    assert "extra" not in payload
    assert payload["level"] == "info"
    assert payload["message"]["formatted"] == "Bildschirm war weiss"
    # The echo is still the queued payload itself, byte for byte.
    assert r.json()["sent"] == payload


@pytest.mark.asyncio
async def test_a_photo_rides_along_and_the_echo_says_so(client, db_session, editor):
    await _login(client, editor)
    raw = _jpeg(5000)
    r = await client.post(
        "/api/diag/report",
        json={"message": "so sah es aus", "photos": [_b64(raw), _b64(_jpeg(600))]},
    )
    assert r.status_code == 202

    row = (await db_session.execute(select(TelemetryOutbox))).scalars().one()
    queued = row.payload_json["extra"]["photos"]
    assert [p["bytes"] for p in queued] == [5000, 600]
    assert base64.b64decode(queued[0]["data"]) == raw
    assert row.payload_json["tags"]["photos"] == "2"

    # What the sheet renders: the count and the sizes, not 7 kB of base64 in a <pre>.
    echoed = r.json()["sent"]["extra"]["photos"]
    assert echoed == [{"mime": "image/jpeg", "bytes": 5000}, {"mime": "image/jpeg", "bytes": 600}]


@pytest.mark.asyncio
async def test_a_third_photo_is_refused_by_validation(client, editor):
    # 422, not a 500 and not a silent truncation — the same contract the message cap keeps.
    await _login(client, editor)
    r = await client.post("/api/diag/report", json={"message": "x", "photos": [_b64(_jpeg(100))] * 3})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_an_oversized_photo_is_refused_before_it_is_decoded(client, editor):
    await _login(client, editor)
    over = "A" * (photos_mod.MAX_PHOTO_B64_CHARS + 4)
    r = await client.post("/api/diag/report", json={"message": "x", "photos": [over]})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_a_photo_the_server_drops_does_not_cost_the_operator_their_words(client, db_session, editor):
    # A non-conforming client sends something that is not a picture. The report is still queued
    # with the text — and the echo reports zero photos, so «ich hab eins angehängt» and «hier
    # liegt keins» are visibly different rather than quietly the same.
    await _login(client, editor)
    r = await client.post("/api/diag/report", json={"message": "wichtig", "photos": [_b64(b"%PDF-1.7 nope")]})
    assert r.status_code == 202

    row = (await db_session.execute(select(TelemetryOutbox))).scalars().one()
    assert row.payload_json["message"]["formatted"] == "wichtig"
    assert "extra" not in row.payload_json


@pytest.mark.asyncio
async def test_the_photo_is_in_the_deployers_log_like_everything_else(client, editor, caplog):
    # The transparency rule holds for the picture too: whatever leaves is in the station's own
    # log first, in full. That is the price of carrying it inside the event, and it is the right
    # way round — a payload the deployer cannot read would be the worse trade.
    await _login(client, editor)
    with caplog.at_level(logging.INFO, logger="kp.telemetry"):
        await client.post("/api/diag/report", json={"message": "x", "photos": [_b64(_jpeg(400))]})
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "exact content follows" in logged
    assert '"bytes": 400' in logged
