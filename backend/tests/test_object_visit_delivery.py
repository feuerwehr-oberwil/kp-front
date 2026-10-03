"""The Objektbesuche delivery outbox against a fake, writable SharePoint drive.

Pinned: the folder layout and file names, a correction landing in the SAME folder with one more
Verlauf entry, a lost response (applied remotely, error locally) healing on the next attempt, two
workers (a stale lease cannot overwrite a newer remote revision), 403 → failed and staying failed
until the config/credentials change, 429 → backoff, a disabled destination pausing its rows,
completion-only timing, a removed photo moving to Entfernt/, and the connection test.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select

from app import credentials as creds
from app import object_visit_delivery as worker
from app import storage as storage_mod
from app.models import ObjectVisitDelivery, ObjectVisitDeliveryLog
from app.schemas import ObjectVisitDestination
from tests.ov_support import jpeg, login, make_object, new_id, put, set_config, upload, visit_doc
from tests.sharepoint_write_fake import CLIENT_ID, CLIENT_SECRET, SITE_URL, TENANT_ID, FakeDrive

ROOT = "FÜ/Einsatzpläne"
OBJ_FOLDER = f"{ROOT}/Hauptstrasse 24 - Gemeindeverwaltung"
DEST = {
    "id": "sharepoint-fu",
    "kind": "sharepoint",
    "enabled": True,
    "timing": "every-sync",
    "siteUrl": SITE_URL,
    "root": ROOT,
}


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


@pytest_asyncio.fixture
async def setup(db_session):
    for name, value in (
        ("sharepoint_export_tenant_id", TENANT_ID),
        ("sharepoint_export_client_id", CLIENT_ID),
        ("sharepoint_export_client_secret", CLIENT_SECRET),
    ):
        await creds.set_value(db_session, name, value, actor_id=None)
    await set_config(db_session, {"destinations": [DEST]})
    obj = await make_object(db_session)
    drive = FakeDrive(seed=[OBJ_FOLDER])
    drive.items[f"{OBJ_FOLDER}/Modul 1.pdf"] = drive.items[OBJ_FOLDER].__class__(
        id="plan-1", path=f"{OBJ_FOLDER}/Modul 1.pdf", folder=False, data=b"%PDF-plan"
    )
    return obj, drive


class Clock:
    def __init__(self) -> None:
        self.at = datetime.now(UTC) + timedelta(seconds=30)

    def __call__(self) -> datetime:
        return self.at

    def advance(self, **kw) -> None:
        self.at += timedelta(**kw)


async def _visit(client, editor, obj, *, photos: int = 1, **over) -> tuple[str, list[str], dict]:
    await login(client, editor)
    vid = new_id("ov")
    atts = [new_id("ova") for _ in range(photos)]
    doc = visit_doc(vid, obj, photos=[{"id": a, "caption": f"Bild {n}"} for n, a in enumerate(atts, 1)], **over)
    assert (await put(client, vid, doc, None)).status_code == 200
    for n, a in enumerate(atts):
        assert (await upload(client, vid, a, jpeg(["red", "green", "blue"][n % 3]))).status_code == 201
    return vid, atts, doc


async def _row(db, vid) -> ObjectVisitDelivery:
    db.expire_all()
    return (await db.execute(select(ObjectVisitDelivery).where(ObjectVisitDelivery.visit_id == vid))).scalar_one()


def _visit_folder(drive: FakeDrive, vid: str) -> str:
    matches = [
        f for f in drive.folders() if f.startswith(f"{OBJ_FOLDER}/Objektbesuche/") and f.endswith(f"({vid[-4:]})")
    ]
    assert len(matches) == 1, drive.folders()
    return matches[0]


async def test_happy_path_layout_and_names(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    vid, atts, _ = await _visit(client, editor, obj)
    assert await worker.run_once(session_factory, transport=drive.transport) == "delivered"

    folder = _visit_folder(drive, vid)
    assert folder == f"{OBJ_FOLDER}/Objektbesuche/2026-10-03 Kontrolle Schlüsselhülse ({vid[-4:]})"
    names = sorted(p[len(folder) + 1 :] for p in drive.files(folder))
    assert "Objektbesuch.pdf" in names and "Objektbesuch.json" in names
    assert f"Fotos/01 Bild 1 ({atts[0][-4:]}).jpg" in names
    verlauf = [n for n in names if n.startswith("Verlauf/")]
    assert len(verlauf) == 2 and all(re.match(r"Verlauf/r1 \d{4}-\d{2}-\d{2} \d{4}\.(pdf|json)$", n) for n in verlauf)
    assert drive.json_at(f"{folder}/Objektbesuch.json")["revision"] == 1
    assert drive.files(folder)[f"{folder}/Objektbesuch.pdf"].startswith(b"%PDF")
    # the plans next to it are untouched, nothing is deleted
    assert drive.items[f"{OBJ_FOLDER}/Modul 1.pdf"].data == b"%PDF-plan"

    row = await _row(db_session, vid)
    assert row.state == "delivered" and row.delivered_revision == 1 and row.attempts == 0 and row.lease_owner is None
    visit = (await client.get(f"/api/object-visits/{vid}")).json()
    assert visit["deliveries"][0]["state"] == "delivered" and visit["deliveries"][0]["revision"] == 1
    events = (await db_session.execute(select(ObjectVisitDeliveryLog.event))).scalars().all()
    assert events == ["claimed", "delivered"]
    assert await worker.run_once(session_factory, transport=drive.transport) is None  # nothing left


async def test_a_correction_lands_in_the_same_folder(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    vid, _, doc = await _visit(client, editor, obj)
    await worker.run_once(session_factory, transport=drive.transport)
    folder = _visit_folder(drive, vid)
    # the date in the folder name changes — the folder must not
    await put(client, vid, {**doc, "lifecycle": "completed", "visitedAt": "2026-10-05T10:00:00+02:00"}, 1)
    assert (await _row(db_session, vid)).state == "pending"
    assert await worker.run_once(session_factory, transport=drive.transport) == "delivered"
    assert _visit_folder(drive, vid) == folder
    verlauf = sorted(n for n in drive.files(f"{folder}/Verlauf"))
    assert len(verlauf) == 4 and any("/r2 " in n for n in verlauf)
    current = drive.json_at(f"{folder}/Objektbesuch.json")
    assert current["revision"] == 2 and current["lifecycle"] == "completed"
    assert (await _row(db_session, vid)).delivered_revision == 2


async def test_a_lost_response_heals_without_duplicates(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    clock = Clock()
    vid, _, _ = await _visit(client, editor, obj, photos=2)
    drive.lose("POST", "/children")  # the visit folder is created, the answer never arrives
    drive.lose("PUT", "Fotos/02")  # the second photo is stored, the answer never arrives
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "retry"
    row = await _row(db_session, vid)
    assert row.state == "pending" and row.next_attempt_at > clock.at and row.last_error
    clock.advance(minutes=2)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "retry"
    clock.advance(minutes=6)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "delivered"
    folder = _visit_folder(drive, vid)  # exactly one visit folder
    photos = sorted(drive.files(f"{folder}/Fotos"))
    assert len(photos) == 2
    assert len([p for p in drive.files(folder) if p.endswith("Objektbesuch.pdf")]) == 1


async def test_a_stale_worker_cannot_overwrite_a_newer_remote_revision(
    client, editor, setup, session_factory, db_session
):
    obj, drive = setup
    clock = Clock()
    vid, _, doc = await _visit(client, editor, obj)
    cfg_dest = ObjectVisitDestination.model_validate(DEST)

    async with session_factory() as db:
        stale = await worker.claim(db, {DEST["id"]}, clock())
        await db.commit()
    assert stale is not None and stale.wanted == 1

    # worker A stalls past its lease; meanwhile the visit is corrected and worker B files r2
    await put(client, vid, {**doc, "notes": "Korrektur"}, 1)
    clock.advance(minutes=6)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "delivered"
    folder = _visit_folder(drive, vid)
    assert drive.json_at(f"{folder}/Objektbesuch.json")["revision"] == 2

    # A wakes up holding r1
    outcome = await worker.deliver(session_factory, stale, cfg_dest, transport=drive.transport, now=clock)
    assert outcome == "superseded"
    assert drive.json_at(f"{folder}/Objektbesuch.json")["revision"] == 2
    row = await _row(db_session, vid)
    assert row.delivered_revision == 2
    # ONE heal pass, after the first backoff step, rewrites the current files at r2
    assert row.state == "pending" and row.next_attempt_at > clock.at
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) is None
    clock.advance(seconds=61)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "delivered"
    assert drive.json_at(f"{folder}/Objektbesuch.json")["revision"] == 2
    assert (await _row(db_session, vid)).delivered_revision == 2


async def test_403_fails_until_the_config_changes(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    clock = Clock()
    vid, _, _ = await _visit(client, editor, obj)
    drive.forbid()
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "failed"
    row = await _row(db_session, vid)
    assert row.state == "failed" and "read-only grant" in row.last_error
    visit = (await client.get(f"/api/object-visits/{vid}")).json()
    assert visit["deliveries"][0]["state"] == "failed" and visit["deliveries"][0]["error"]
    clock.advance(hours=7)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) is None  # no auto-retry

    drive.writes_forbidden = False
    await set_config(db_session, {"destinations": [{**DEST, "visitFolder": "Besuche/{date} ({short})"}]})
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "delivered"
    assert any(f.startswith(f"{OBJ_FOLDER}/Besuche/2026-10-03 (") for f in drive.folders())


async def test_429_backs_off(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    clock = Clock()
    vid, _, _ = await _visit(client, editor, obj)
    drive.fail("PUT", "Objektbesuch.pdf", 429)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "retry"
    row = await _row(db_session, vid)
    assert row.state == "pending" and row.attempts == 1
    assert row.next_attempt_at - clock.at == timedelta(seconds=60)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) is None  # not due yet
    clock.advance(seconds=61)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "delivered"
    assert worker.backoff(1) == timedelta(minutes=1) and worker.backoff(4) == timedelta(hours=1)
    assert worker.backoff(9) == timedelta(hours=6)


async def test_a_disabled_destination_pauses_its_rows(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    vid, _, doc = await _visit(client, editor, obj)
    await set_config(db_session, {"destinations": [{**DEST, "enabled": False}]})
    assert await worker.run_once(session_factory, transport=drive.transport) is None
    assert (await _row(db_session, vid)).state == "paused"
    assert drive.files(f"{OBJ_FOLDER}/Objektbesuche") == {}
    await set_config(db_session, {"destinations": [DEST]})
    assert await worker.run_once(session_factory, transport=drive.transport) == "delivered"
    # removed altogether → paused as well, and kept
    await set_config(db_session, {"destinations": []})
    await put(client, vid, {**doc, "photos": []}, 1)
    await worker.run_once(session_factory, transport=drive.transport)
    row = await _row(db_session, vid)
    assert row.delivered_revision == 1


async def test_completion_only_timing(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    await set_config(db_session, {"destinations": [{**DEST, "timing": "completed"}]})
    vid, _, doc = await _visit(client, editor, obj)
    assert (await db_session.execute(select(ObjectVisitDelivery))).scalars().all() == []
    assert await worker.run_once(session_factory, transport=drive.transport) is None
    await put(client, vid, {**doc, "lifecycle": "completed"}, 1)
    assert await worker.run_once(session_factory, transport=drive.transport) == "delivered"
    folder = _visit_folder(drive, vid)
    verlauf = sorted(drive.files(f"{folder}/Verlauf"))
    assert len(verlauf) == 2 and all("/r2 " in n for n in verlauf)  # the draft r1 was never filed


async def test_a_removed_photo_moves_to_entfernt(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    vid, atts, doc = await _visit(client, editor, obj, photos=2)
    await worker.run_once(session_factory, transport=drive.transport)
    folder = _visit_folder(drive, vid)
    assert len(drive.files(f"{folder}/Fotos")) == 2
    await put(client, vid, {**doc, "photos": doc["photos"][:1]}, 1)
    assert await worker.run_once(session_factory, transport=drive.transport) == "delivered"
    assert len(drive.files(f"{folder}/Fotos")) == 1
    removed = drive.files(f"{folder}/Entfernt")
    assert len(removed) == 1 and atts[1][-4:] in next(iter(removed))
    row = await _row(db_session, vid)
    assert atts[1] in row.remote_items["_removed"] and atts[1] not in row.remote_items


async def test_discarded_after_filing_is_filed_under_completed_timing(
    client, editor, setup, session_factory, db_session
):
    obj, drive = setup
    await set_config(db_session, {"destinations": [{**DEST, "timing": "completed"}]})
    vid, _, doc = await _visit(client, editor, obj, photos=0)
    await put(client, vid, {**doc, "lifecycle": "discarded"}, 1)
    # never filed → a discarded draft is not filed either
    assert (await db_session.execute(select(ObjectVisitDelivery))).scalars().all() == []


async def test_the_connection_test_writes_one_file(setup):
    _, drive = setup
    dest = ObjectVisitDestination.model_validate(DEST)
    answer = await worker.test_destination(dest, transport=drive.transport)
    assert answer["ok"] is True
    assert f"{ROOT}/_kp-front-test.txt" in drive.files(ROOT)
    missing = ObjectVisitDestination.model_validate({**DEST, "root": "Gibt/Es/Nicht"})
    answer = await worker.test_destination(missing, transport=drive.transport)
    assert answer["ok"] is False and answer["status"] == 404


async def test_the_job_is_registered_unconditionally(monkeypatch):
    import app.plans as plans_mod
    from app import scheduler
    from app.config import settings

    monkeypatch.setattr(scheduler, "_scheduler", None)
    monkeypatch.setattr(plans_mod, "plans_pull_enabled", lambda: False)
    monkeypatch.setattr(settings, "demo_reset_cron", "")
    monkeypatch.setattr(settings, "demo_reset_seconds", 0)
    try:
        scheduler._start_scheduler_jobs()
        ids = {j.id for j in scheduler._scheduler.get_jobs()}
    finally:
        scheduler._stop_scheduler_jobs()
    assert "object_visit_delivery" in ids


async def test_idle_without_credentials(client, editor, db_session, session_factory):
    await set_config(db_session, {"destinations": [DEST]})
    obj = await make_object(db_session)
    await _visit(client, editor, obj, photos=0)
    drive = FakeDrive(seed=[OBJ_FOLDER])
    assert await worker.run_once(session_factory, transport=drive.transport) is None
    assert drive.seen == []


# --- review fixes (03.10.2026) ---------------------------------------------------------------------


async def test_a_remote_ahead_of_the_server_fails_instead_of_looping(
    client, editor, setup, session_factory, db_session
):
    """Regression: the fence used to put the row straight back to `pending` with the same due
    time, so every run_once re-claimed it — a tick-long superseded loop that starved every other
    delivery and wrote a log row each time. Holding the lease and finding a NEWER remote revision
    is not a lost race: the remote is ahead of this server, and that needs a person."""
    obj, drive = setup
    clock = Clock()
    vid, _, _ = await _visit(client, editor, obj)
    folder = f"{OBJ_FOLDER}/Objektbesuche/2026-10-03 Kontrolle Schlüsselhülse ({vid[-4:]})"
    drive.mkdirs(folder)
    drive.items[f"{folder}/Objektbesuch.json"] = drive.items[folder].__class__(
        id="remote-json", path=f"{folder}/Objektbesuch.json", folder=False, data=b'{"revision": 8}', etag='"e"'
    )
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "failed"
    row = await _row(db_session, vid)
    assert row.state == "failed"
    assert row.last_error == "Ablage hat neuere Revision r8 als der Server (r1) – prüfen"
    assert row.remote_items["_path"] == folder  # the folder it found is kept
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) is None
    claims = (
        await db_session.execute(select(ObjectVisitDeliveryLog).where(ObjectVisitDeliveryLog.event == "claimed"))
    ).all()
    assert len(claims) == 1
    visit = (await client.get(f"/api/object-visits/{vid}")).json()
    assert visit["deliveries"][0]["state"] == "failed"


async def test_a_412_while_holding_the_lease_backs_off(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    clock = Clock()
    vid, _, _ = await _visit(client, editor, obj)
    drive.fail("PUT", "Objektbesuch.json", 412)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "retry"
    row = await _row(db_session, vid)
    assert row.state == "pending" and row.next_attempt_at > clock.at
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) is None


async def test_a_report_that_cannot_render_fails_with_a_reason(
    client, editor, setup, session_factory, db_session, monkeypatch
):
    obj, drive = setup
    vid, _, _ = await _visit(client, editor, obj)

    def boom(*_a, **_k):
        raise ValueError("kaputt")

    monkeypatch.setattr("app.object_visit_report.render_visit_pdf", boom)
    assert await worker.run_once(session_factory, transport=drive.transport) == "failed"
    row = await _row(db_session, vid)
    assert row.state == "failed" and row.last_error.startswith("Bericht r1 konnte nicht erstellt werden")


async def test_switching_to_completed_leaves_queued_drafts_idle(client, editor, setup, session_factory, db_session):
    """Regression: drafts queued under every-sync, then the destination switched to completed —
    the worker used to raise «no eligible revision» (409) and back off forever."""
    obj, drive = setup
    clock = Clock()
    vid, _, doc = await _visit(client, editor, obj)
    await set_config(db_session, {"destinations": [{**DEST, "timing": "completed"}]})
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "idle"
    row = await _row(db_session, vid)
    assert row.state == "delivered" and row.last_error is None and row.wanted_revision == 0
    assert drive.files(f"{OBJ_FOLDER}/Objektbesuche") == {}
    assert (await client.get(f"/api/object-visits/{vid}")).json()["deliveries"] == []
    # a completed revision later is filed normally
    await put(client, vid, {**doc, "lifecycle": "completed"}, 1)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "delivered"
    assert (await _row(db_session, vid)).delivered_revision == 2


async def test_remove_readd_remove_never_leaves_the_photo_in_fotos(client, editor, setup, session_factory, db_session):
    obj, drive = setup
    vid, atts, doc = await _visit(client, editor, obj, photos=2)
    await worker.run_once(session_factory, transport=drive.transport)
    folder = _visit_folder(drive, vid)
    one = {**doc, "photos": doc["photos"][:1]}
    await put(client, vid, one, 1)
    await worker.run_once(session_factory, transport=drive.transport)
    await put(client, vid, doc, 2)  # re-added
    await worker.run_once(session_factory, transport=drive.transport)
    assert len(drive.files(f"{folder}/Fotos")) == 2
    await put(client, vid, one, 3)  # removed again — Entfernt/ already holds that name
    assert await worker.run_once(session_factory, transport=drive.transport) == "delivered"
    assert len(drive.files(f"{folder}/Fotos")) == 1
    assert len(drive.files(f"{folder}/Entfernt")) == 2


async def test_history_renders_decode_each_photo_once(client, editor, setup, session_factory, db_session, monkeypatch):
    from app import object_visit_report

    obj, drive = setup
    clock = Clock()
    vid, _, doc = await _visit(client, editor, obj, photos=2)
    await put(client, vid, {**doc, "notes": "zwei"}, 1)
    await put(client, vid, {**doc, "notes": "drei"}, 2)
    calls: list[int] = []
    real = object_visit_report.downscale_photo

    def counting(data: bytes):
        calls.append(len(data))
        return real(data)

    monkeypatch.setattr(object_visit_report, "downscale_photo", counting)
    assert await worker.run_once(session_factory, transport=drive.transport, now=clock) == "delivered"
    assert len(calls) == 2  # three reports, two photos, each original decoded once
    folder = _visit_folder(drive, vid)
    assert len(drive.files(f"{folder}/Verlauf")) == 6


async def test_housekeeping_bumps_each_visit_once_in_order(client, editor, setup, session_factory, db_session):
    obj, _drive = setup
    a, _, _ = await _visit(client, editor, obj, photos=0)
    b, _, _ = await _visit(client, editor, obj, photos=0)
    await set_config(db_session, {"destinations": [{**DEST, "enabled": False}]})
    from app import object_visits as ov
    from app.models import ObjectVisit

    async with session_factory() as db:
        moved = await worker.housekeeping(db, await ov.ov_config(db), datetime.now(UTC))
        await db.commit()
    assert moved == 2
    db_session.expire_all()
    seqs = sorted(
        (await db_session.execute(select(ObjectVisit.id, ObjectVisit.seq).where(ObjectVisit.id.in_([a, b])))).all()
    )
    assert seqs[0].seq != seqs[1].seq and abs(seqs[0].seq - seqs[1].seq) == 1
