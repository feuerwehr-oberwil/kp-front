"""The Einsatz-Ablage (docs/incident-archive.md) against a fake, writable SharePoint drive.

Pinned: the config is refused at load when a pattern cannot work; folder names come from the
alarm date and the Stichwort without the address; a close queues one row and never waits for
SharePoint; an Übung is never filed; a re-run uploads nothing twice, also after a lost response;
a Nachtrag files a NEW Rapport version and the old one stays; weather backs off, a refused grant
fails visibly and «Erneut versuchen» takes it back; two Einsätze never share a folder; a folder a
person moved still receives the late photo.
"""

from __future__ import annotations

import json
import uuid
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import pytest_asyncio
from pydantic import ValidationError
from sqlalchemy import select

from app import credentials as creds
from app import incident_archive as archive
from app import storage as storage_mod
from app.models import DeploymentConfig, Incident, IncidentArchiveDelivery, IncidentArchiveReport
from app.schemas import IncidentArchiveConfig, IncidentArchiveDestination
from tests.ov_support import jpeg, login
from tests.sharepoint_write_fake import CLIENT_ID, CLIENT_SECRET, SITE_URL, TENANT_ID, FakeDrive

PHOTOS = "Fotoarchiv/Laufendes Jahr"
REPORTS = "Einsatzakten"
DEST = {
    "id": "sp",
    "kind": "sharepoint",
    "siteUrl": SITE_URL,
    "photoFolder": f"{PHOTOS}/{{date}} {{stichwort}}",
    "reportFolder": f"{REPORTS}/{{year}}/{{date}} {{stichwort}}",
}
#: 14.07.2026 23:30 UTC is already the 15th in Zurich – the folder carries the local alarm date
ALARM = "2026-07-14T23:30:00+00:00"


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


async def _config(db, section: dict | None) -> None:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    doc = {"incidentArchive": section} if section is not None else {}
    if row is None:
        db.add(DeploymentConfig(id=1, config_json=doc))
    else:
        row.config_json = doc
    await db.commit()


@pytest_asyncio.fixture
async def drive(db_session):
    for name, value in (
        ("sharepoint_export_tenant_id", TENANT_ID),
        ("sharepoint_export_client_id", CLIENT_ID),
        ("sharepoint_export_client_secret", CLIENT_SECRET),
    ):
        await creds.set_value(db_session, name, value, actor_id=None)
    await _config(db_session, {"enabled": True, "destinations": [DEST]})
    return FakeDrive(seed=[PHOTOS, REPORTS])


async def _incident(client, editor, **over) -> str:
    await login(client, editor)
    body = {"title": "Ölspur Hauptstrasse 4", "address": "Hauptstrasse 4, 4100 Musterdorf", "started_at": ALARM}
    r = await client.post("/api/incidents", json={**body, **over})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _upload(client, inc: str, kind: str = "photo", data: bytes | None = None) -> str:
    name, ctype = {"photo": ("a.jpg", "image/jpeg"), "audio": ("a.webm", "audio/webm")}[kind]
    r = await client.post(
        f"/api/incidents/{inc}/media", files={"file": (name, data or jpeg(), ctype)}, data={"kind": kind}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _report(client, inc: str, summary: str = "Ölspur gebunden.", at: str = "15.07.2026 01:00") -> None:
    payload = {"incident": {"title": "Ölspur", "id": inc}, "generatedAt": at, "meta": {"summary": summary}}
    r = await client.post(f"/api/incidents/{inc}/report/pdf", data={"payload": json.dumps(payload)})
    assert r.status_code == 200, r.text


async def _close(client, inc: str) -> None:
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": True})).status_code == 200


async def _row(db, inc: str) -> IncidentArchiveDelivery | None:
    db.expire_all()
    return (
        await db.execute(select(IncidentArchiveDelivery).where(IncidentArchiveDelivery.incident_id == uuid.UUID(inc)))
    ).scalar_one_or_none()


def _puts(drive: FakeDrive) -> list[str]:
    return [url for method, url in drive.seen if method == "PUT"]


# --- config + names ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("over", "message"),
    [
        ({"photoFolder": "Fotos/{datum} {stichwort}"}, "unknown placeholder"),
        ({"photoFolder": "Fotos/{year}/alle"}, "last level"),
        ({"reportFolder": "Akten/../{date}"}, "plain folder pattern"),
        ({"siteUrl": "http://example.sharepoint.com"}, "https://"),
        ({"id": "SP 1"}, "'id'"),
    ],
)
def test_a_pattern_that_cannot_work_is_refused_at_load(over, message):
    with pytest.raises(ValidationError, match=message):
        IncidentArchiveConfig.model_validate({"enabled": True, "destinations": [{**DEST, **over}]})


def test_two_destinations_need_two_ids():
    with pytest.raises(ValidationError, match="used twice"):
        IncidentArchiveConfig.model_validate({"destinations": [DEST, DEST]})


def test_the_section_defaults_to_off():
    assert IncidentArchiveConfig().enabled is False


@pytest.mark.parametrize(
    ("title", "address", "expected"),
    [
        ("Ölspur", "Hauptstrasse 4, 4100 Musterdorf", "Ölspur"),
        ("Brand Dachstock, Hauptstrasse 4", "Hauptstrasse 4, 4100 Musterdorf", "Brand Dachstock"),
        ("BMA Alarm Industriestrasse", "Industriestrasse 12, 4100 Musterdorf", "BMA Alarm"),
        ("Hauptstrasse 4", "Hauptstrasse 4", ""),
    ],
)
def test_the_stichwort_leaves_the_address_out(title, address, expected):
    assert archive.stichwort(title, address) == expected


def test_placeholders_and_sanitising():
    inc = Incident(
        id=uuid.UUID("00000000-0000-4000-8000-00000000beef"),
        title='Brand: "Scheune"/Stall?',
        type=None,
        address=None,
        started_at=datetime(2026, 7, 14, 23, 30, tzinfo=UTC),
    )
    values = archive.placeholders(inc)
    assert values == {
        "date": "2026.07.15",
        "year": "2026",
        "stichwort": 'Brand: "Scheune"/Stall?',
        "kategorie": "Einsatz",
        "short": "beef",
    }
    # a «/» in a value never adds a level, and what SharePoint refuses is removed
    assert archive.expand("Akten/{year}/{date} {stichwort}", values) == [
        "Akten",
        "2026",
        "2026.07.15 Brand ScheuneStall",
    ]
    # only the title's address goes; an Einsatz with just an address is named by its Kategorie
    inc.title, inc.address, inc.type = "Hauptstrasse 4", "Hauptstrasse 4", "Ölwehr"
    assert archive.placeholders(inc)["stichwort"] == "Ölwehr"


async def test_the_destinations_reach_an_admin_only(client, editor, drive):
    await login(client, editor)
    assert (await client.get("/api/config")).json()["incidentArchive"]["destinations"] == []


# --- close → filed -----------------------------------------------------------------------------


async def test_a_close_files_photos_audio_and_the_rapport(client, editor, drive, session_factory, db_session):
    inc = await _incident(client, editor)
    await _upload(client, inc)
    await _upload(client, inc)
    await _upload(client, inc, "audio", b"\x1a\x45\xdf\xa3webm")
    await _report(client, inc)
    assert await _row(db_session, inc) is None  # nothing owed while it runs
    await _close(client, inc)
    assert (await _row(db_session, inc)).state == "pending"

    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    photo_dir = f"{PHOTOS}/2026.07.15 Ölspur"
    report_dir = f"{REPORTS}/2026/2026.07.15 Ölspur"
    photos = sorted(p.rsplit("/", 1)[1] for p in drive.files(photo_dir))
    assert len(photos) == 2 and photos[0].startswith("01 ") and photos[1].startswith("02 ")
    assert all(p.endswith(".jpg") for p in photos)
    docs = sorted(p.rsplit("/", 1)[1] for p in drive.files(report_dir))
    assert docs[0] == "Einsatzrapport.pdf" and docs[1].startswith("Sprachnotiz 01 ") and docs[1].endswith(".webm")
    assert drive.files(report_dir)[f"{report_dir}/Einsatzrapport.pdf"].startswith(b"%PDF")
    # the originals, byte for byte
    assert drive.files(photo_dir)[f"{photo_dir}/{photos[0]}"] == jpeg()
    row = await _row(db_session, inc)
    assert row.state == "delivered" and row.last_error is None and row.delivered_at is not None


async def test_an_uebung_is_never_filed(client, editor, drive, session_factory, db_session):
    inc = await _incident(client, editor, is_exercise=True)
    await _upload(client, inc)
    await _close(client, inc)
    assert await _row(db_session, inc) is None
    assert await archive.run_once(session_factory, transport=drive.transport) is None
    assert drive.files() == {}


async def test_switched_off_nothing_is_queued_or_kept(client, editor, drive, db_session):
    await _config(db_session, {"enabled": False, "destinations": [DEST]})
    inc = await _incident(client, editor)
    await _report(client, inc)
    await _close(client, inc)
    assert await _row(db_session, inc) is None
    assert await db_session.get(IncidentArchiveReport, uuid.UUID(inc)) is None


async def test_closing_works_while_sharepoint_refuses(client, editor, drive, session_factory, db_session):
    drive.forbid()
    inc = await _incident(client, editor)
    await _upload(client, inc)
    await _close(client, inc)  # 200, whatever SharePoint says
    assert await archive.run_once(session_factory, transport=drive.transport) == "failed"
    row = await _row(db_session, inc)
    assert row.state == "failed" and "read-only grant" in row.last_error
    # the same Einsatz still reopens and closes
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": False})).status_code == 200
    await _close(client, inc)
    assert (await _row(db_session, inc)).state == "pending"


# --- idempotency, versions ---------------------------------------------------------------------


async def test_a_rerun_uploads_nothing_twice(client, editor, drive, session_factory, db_session):
    inc = await _incident(client, editor)
    await _upload(client, inc)
    await _upload(client, inc)
    await _close(client, inc)
    drive.lose("PUT", "02 ")  # the second photo lands remotely, its answer is lost
    assert await archive.run_once(session_factory, transport=drive.transport) == "retry"
    assert len(_puts(drive)) == 2
    row = await _row(db_session, inc)
    assert row.state == "pending" and len(row.remote_items["media"]) == 1  # the first one is remembered
    # due again after the backoff: only the lost one is sent once more, to the same name
    later = datetime.now(UTC) + timedelta(minutes=2)
    assert await archive.run_once(session_factory, transport=drive.transport, now=lambda: later) == "delivered"
    assert len(_puts(drive)) == 3
    assert len(drive.files(f"{PHOTOS}/2026.07.15 Ölspur")) == 2
    # closing again owes a pass – and it sends nothing
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": False})).status_code == 200
    await _close(client, inc)
    assert await archive.run_once(session_factory, transport=drive.transport, now=lambda: later) == "delivered"
    assert len(_puts(drive)) == 3


async def test_a_nachtrag_files_a_new_rapport_version(client, editor, drive, session_factory, db_session):
    inc = await _incident(client, editor)
    await _report(client, inc)
    await _close(client, inc)
    await archive.run_once(session_factory, transport=drive.transport)
    report_dir = f"{REPORTS}/2026/2026.07.15 Ölspur"
    first = drive.files(report_dir)[f"{report_dir}/Einsatzrapport.pdf"]

    # the same Rapport printed again later is the same version
    await _report(client, inc, at="16.07.2026 09:00")
    assert (await _row(db_session, inc)).state == "delivered"

    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": False})).status_code == 200
    await _report(client, inc, summary="Ölspur gebunden. Nachtrag: Strasse gereinigt.")
    await _upload(client, inc)  # still open: owed at the next close
    assert (await _row(db_session, inc)).state == "delivered"
    await _close(client, inc)
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    files = drive.files(report_dir)
    assert sorted(p.rsplit("/", 1)[1] for p in files) == ["Einsatzrapport v2.pdf", "Einsatzrapport.pdf"]
    assert files[f"{report_dir}/Einsatzrapport.pdf"] == first  # never overwritten
    assert len(drive.files(f"{PHOTOS}/2026.07.15 Ölspur")) == 1


async def test_a_late_upload_after_the_close_is_filed(client, editor, drive, session_factory, db_session):
    inc = await _incident(client, editor)
    await _close(client, inc)
    await archive.run_once(session_factory, transport=drive.transport)
    assert drive.files() == {}  # nothing to file yet, and no empty folders
    await _upload(client, inc)  # the offline queue arrives after the close
    assert (await _row(db_session, inc)).state == "pending"
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    assert len(drive.files(f"{PHOTOS}/2026.07.15 Ölspur")) == 1


async def test_two_einsaetze_never_share_a_folder(client, editor, drive, session_factory, db_session):
    a = await _incident(client, editor)
    b = await _incident(client, editor)
    for inc in (a, b):
        await _upload(client, inc)
        await _close(client, inc)
        assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    assert f"{PHOTOS}/2026.07.15 Ölspur" in drive.folders()
    assert f"{PHOTOS}/2026.07.15 Ölspur (2)" in drive.folders()


async def test_a_pending_close_waits_for_the_reopened_incident_to_close_again(client, editor, drive, session_factory):
    inc = await _incident(client, editor)
    await _close(client, inc)
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": False})).status_code == 200
    await _upload(client, inc)
    await _report(client, inc)
    await archive.run_once(session_factory, transport=drive.transport)
    assert drive.files() == {}
    await _close(client, inc)
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    assert len(drive.files()) == 2


@pytest.mark.parametrize("legacy", [False, True])
async def test_a_corrected_title_keeps_the_original_archive_folders(
    client, editor, drive, session_factory, db_session, legacy
):
    inc = await _incident(client, editor)
    await _upload(client, inc)
    await _report(client, inc)
    await _close(client, inc)
    await archive.run_once(session_factory, transport=drive.transport)
    if legacy:
        row = await _row(db_session, inc)
        # Before the template was kept, the key was the expanded path.
        row.remote_items = {
            **row.remote_items,
            "folders": {
                entry["path"]: {"id": entry["id"], "path": entry["path"]}
                for entry in row.remote_items["folders"].values()
            },
        }
        row.remote_items.pop("folderPatterns", None)
        await db_session.commit()
    assert (await client.patch(f"/api/incidents/{inc}", json={"title": "Kellerbrand"})).status_code == 200
    await _upload(client, inc)
    await _report(client, inc, summary="Nachtrag")
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    assert len(drive.files(f"{PHOTOS}/2026.07.15 Ölspur")) == 2
    assert len(drive.files(f"{REPORTS}/2026/2026.07.15 Ölspur")) == 2


@pytest.mark.parametrize("current_title", ["A", "B", "C"])
def test_an_ambiguous_legacy_archive_preserves_both_folders(current_title):
    dest = IncidentArchiveDestination.model_validate(DEST)
    first, second = f"{PHOTOS}/2026.07.15 A", f"{PHOTOS}/2026.07.15 B"
    report = f"{REPORTS}/2026/2026.07.15 {current_title}"
    folders = {
        first: {"path": first, "id": "first"},
        second: {"path": second, "id": "second"},
        report: {"id": "report"},
    }
    items = {"folders": folders.copy()}
    with pytest.raises(archive.AmbiguousArchiveFolderError) as error:
        archive.bind_folder_patterns(items, dest, {"year": "2026", "date": "2026.07.15", "stichwort": current_title})
    assert archive.is_actionable(error.value)
    assert items["folders"] == folders
    assert items["folderPatterns"] == {}


def test_long_template_keeps_a_short_legacy_rendering_after_a_rename():
    pattern = f"{PHOTOS}/{'x' * 110}{{stichwort}}"
    dest = IncidentArchiveDestination.model_validate({**DEST, "photoFolder": pattern})
    original = "/".join(archive.expand(pattern, {"stichwort": "A"}))
    items = {"folders": {original: {"id": "original"}}}
    archive.bind_folder_patterns(items, dest, {"stichwort": "B"})
    assert items["folderPatterns"] == {pattern: original}


@pytest.mark.parametrize("old_title", ["A" * 60, "A" * 50 + "." * 9 + "A"])
def test_clipped_legacy_name_requires_reconciliation_before_creating_a_folder(old_title):
    pattern = f"{PHOTOS}/{'x' * 65}{{stichwort}}-photos"
    dest = IncidentArchiveDestination.model_validate({**DEST, "photoFolder": pattern})
    original = "/".join(archive.expand(pattern, {"stichwort": old_title}))
    items = {"folders": {original: {"id": "original"}}}
    with pytest.raises(archive.AmbiguousArchiveFolderError):
        archive.bind_folder_patterns(items, dest, {"stichwort": "B"})
    assert items["folderPatterns"] == {}


def test_short_date_template_does_not_claim_an_unrelated_legacy_key_in_the_same_tree():
    pattern = f"{PHOTOS}/{{year}}-new"
    dest = IncidentArchiveDestination.model_validate({**DEST, "photoFolder": pattern})
    items = {"folders": {f"{PHOTOS}/2025-old": {"id": "old"}}}
    archive.bind_folder_patterns(items, dest, {"year": "2026"})
    assert items["folderPatterns"] == {}


def test_a_truncated_key_cannot_be_bound_to_another_folder_pattern_that_matches_its_visible_text():
    photo = f"{PHOTOS}/{'x' * 65}{{stichwort}}-photos"
    report = f"{PHOTOS}/{{kategorie}}"
    dest = IncidentArchiveDestination.model_validate({**DEST, "photoFolder": photo, "reportFolder": report})
    original = "/".join(archive.expand(photo, {"stichwort": "A" * 60}))
    items = {"folders": {original: {"id": "photo"}}}
    with pytest.raises(archive.AmbiguousArchiveFolderError):
        archive.bind_folder_patterns(items, dest, {"stichwort": "B", "kategorie": "Brand"})
    assert items["folderPatterns"] == {}


def test_unique_untruncated_sibling_patterns_with_different_suffixes_keep_their_bindings():
    photo, report = f"{PHOTOS}/{{stichwort}}-photos", f"{PHOTOS}/{{stichwort}}-reports"
    dest = IncidentArchiveDestination.model_validate({**DEST, "photoFolder": photo, "reportFolder": report})
    a, b = f"{PHOTOS}/A-photos", f"{PHOTOS}/B-reports"
    items = {"folders": {a: {"id": "photo"}, b: {"id": "report"}}}
    archive.bind_folder_patterns(items, dest, {"stichwort": "C"})
    assert items["folderPatterns"] == {photo: a, report: b}


async def test_a_moved_folder_still_receives(client, editor, drive, session_factory, db_session):
    inc = await _incident(client, editor)
    await _upload(client, inc)
    await _close(client, inc)
    await archive.run_once(session_factory, transport=drive.transport)
    # the year ends: a person moves the folder into the archive
    drive.relocate(f"{PHOTOS}/2026.07.15 Ölspur", "Fotoarchiv/2026/2026.07.15 Ölspur")
    await _upload(client, inc)
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    assert len(drive.files("Fotoarchiv/2026/2026.07.15 Ölspur")) == 2
    assert f"{PHOTOS}/2026.07.15 Ölspur" not in drive.folders()


# --- failures and the admin's view -------------------------------------------------------------


async def test_weather_backs_off_and_says_why(client, editor, drive, session_factory, db_session):
    inc = await _incident(client, editor)
    await _upload(client, inc)
    await _close(client, inc)
    drive.fail("PUT", "01 ", 503)
    assert await archive.run_once(session_factory, transport=drive.transport) == "retry"
    row = await _row(db_session, inc)
    assert row.state == "pending" and row.attempts == 1 and "503" in row.last_error
    assert row.next_attempt_at > datetime.now(UTC) + timedelta(seconds=50)
    assert await archive.run_once(session_factory, transport=drive.transport) is None  # not due yet
    later = datetime.now(UTC) + timedelta(minutes=2)
    assert await archive.run_once(session_factory, transport=drive.transport, now=lambda: later) == "delivered"
    assert (await _row(db_session, inc)).last_error is None


async def test_a_missing_base_folder_fails_and_retry_takes_it_back(
    client, editor, drive, session_factory, db_session, admin_login
):
    del drive.items[PHOTOS]  # the configured base does not exist: a person has to look
    inc = await _incident(client, editor)
    await _upload(client, inc)
    await _close(client, inc)
    assert await archive.run_once(session_factory, transport=drive.transport) == "failed"
    await admin_login(client)
    status = (await client.get("/api/admin/incident-archive")).json()
    assert status["enabled"] is True
    [entry] = status["deliveries"]
    assert entry["incidentId"] == inc and entry["state"] == "failed" and "does not exist" in entry["lastError"]
    assert await archive.run_once(session_factory, transport=drive.transport) is None  # stays failed

    drive.mkdirs(PHOTOS)
    r = await client.post("/api/admin/incident-archive/retry", json={"incidentId": inc})
    assert r.status_code == 200 and r.json() == {"retried": 1}
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"


async def test_ablegen_files_an_einsatz_closed_before_the_switch(
    client, editor, drive, session_factory, db_session, admin_login
):
    await _config(db_session, {"enabled": False, "destinations": [DEST]})
    inc = await _incident(client, editor)
    await _upload(client, inc)
    await _close(client, inc)
    await _config(db_session, {"enabled": True, "destinations": [DEST]})
    await admin_login(client)
    assert (await client.post("/api/admin/incident-archive/retry", json={"incidentId": inc})).json() == {"retried": 1}
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    assert len(drive.files(f"{PHOTOS}/2026.07.15 Ölspur")) == 1


async def test_a_big_einsatz_is_filed_over_several_passes(
    client, editor, drive, session_factory, db_session, monkeypatch
):
    monkeypatch.setattr(archive, "PASS_FILES", 2)
    inc = await _incident(client, editor)
    for _ in range(3):
        await _upload(client, inc)
    await _close(client, inc)
    assert await archive.run_once(session_factory, transport=drive.transport) == "more"
    assert len((await _row(db_session, inc)).remote_items["media"]) == 2
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    assert len(drive.files(f"{PHOTOS}/2026.07.15 Ölspur")) == 3


async def test_a_rapport_beilage_never_lands_in_the_photo_archive(client, editor, drive, session_factory, db_session):
    inc = await _incident(client, editor)
    await _upload(client, inc)  # a Lage photo
    beilage = await _upload(client, inc)  # «Ausweis Lenker» – a photo by kind, a document by purpose
    row = await db_session.get(Incident, uuid.UUID(inc))
    row.map_workspace_json = {"attachments": [{"id": "a1", "url": f"/api/media/{beilage}", "caption": "Ausweis"}]}
    await db_session.commit()
    await _close(client, inc)
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    photos = [p.rsplit("/", 1)[1] for p in drive.files(f"{PHOTOS}/2026.07.15 Ölspur")]
    docs = [p.rsplit("/", 1)[1] for p in drive.files(f"{REPORTS}/2026/2026.07.15 Ölspur")]
    assert len(photos) == 1 and photos[0].startswith("01 ")
    assert len(docs) == 1 and docs[0].startswith("Beilage 01 ") and docs[0].endswith(".jpg")


async def test_a_lost_rapport_upload_never_hands_its_name_to_a_newer_rapport(
    client, editor, drive, session_factory, db_session
):
    inc = await _incident(client, editor)
    await _report(client, inc)
    await _close(client, inc)
    drive.lose("PUT", "Einsatzrapport.pdf")  # landed remotely, the answer is lost
    assert await archive.run_once(session_factory, transport=drive.transport) == "retry"
    await _report(client, inc, summary="Ölspur gebunden, Strasse gereinigt.")  # a newer Rapport meanwhile
    later = datetime.now(UTC) + timedelta(minutes=2)
    assert await archive.run_once(session_factory, transport=drive.transport, now=lambda: later) == "delivered"
    report_dir = f"{REPORTS}/2026/2026.07.15 Ölspur"
    assert sorted(p.rsplit("/", 1)[1] for p in drive.files(report_dir)) == [
        "Einsatzrapport v2.pdf",
        "Einsatzrapport.pdf",
    ]


# --- a Rapport printed before the Ablage existed --------------------------------------------


def _printed_pdf(order=(3, 2, 1), *, total=3) -> bytes:
    import io

    from reportlab.lib.units import mm
    from reportlab.pdfgen.canvas import Canvas

    buf = io.BytesIO()
    c = Canvas(buf)
    for n in order:
        c.drawString(50, 700, f"Original page {n}")
        c.setFont("Helvetica", 8)
        c.drawRightString(c._pagesize[0] - 14 * mm, 8 * mm, f"{n} / {total}")
        c.showPage()
    c.save()
    return buf.getvalue()


@pytest.mark.parametrize("order", [(1, 2, 3), (3, 2, 1), (1,)])
def test_recovered_printer_pdf_uses_its_own_footer_for_reading_order(order):
    from app.admin_incident_archive import reading_order_pdf

    source = _printed_pdf(order, total=len(order))
    pdf, pages, reversed_pages = reading_order_pdf(source)
    assert pages == len(order)
    assert reversed_pages is (order[0] != 1)
    if not reversed_pages:
        assert pdf == source
    import pypdfium2 as pdfium

    from app.pdfium_lock import pdfium_lock

    with pdfium_lock, pdfium.PdfDocument(pdf) as doc:
        for n, page in enumerate(doc, 1):
            with closing(page), closing(page.get_textpage()) as text:
                assert f"Original page {n}" in text.get_text_range()


@pytest.mark.parametrize("order,total", [((2, 1, 3), 3), ((3, 2, 2), 3), ((3, 2, 1), 4)])
def test_recovery_refuses_ambiguous_or_incomplete_printed_pages(order, total):
    from app.admin_incident_archive import reading_order_pdf

    with pytest.raises(ValueError, match="page"):
        reading_order_pdf(_printed_pdf(order, total=total))


async def _old_print_job(db, inc, **over):
    from app.models import PrintJob

    job = PrintJob(
        incident_id=uuid.UUID(inc),
        kind="report",
        filename="Einsatzrapport.pdf",
        pdf=_printed_pdf(),
        status="done",
        created_at=datetime(2026, 7, 15, tzinfo=UTC),
    )
    for k, v in over.items():
        setattr(job, k, v)
    db.add(job)
    await db.commit()
    return job


async def test_recover_print_job_dry_run_apply_delivery_and_second_dry_run(
    client, editor, drive, session_factory, db_session, monkeypatch, capsys
):
    from app import admin_incident_archive as cli

    inc = await _incident(client, editor)
    await _close(client, inc)
    # Exact production symptom: an empty pass claims delivered, no PDF or folders exist.
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    job = await _old_print_job(db_session, inc)
    source, job_id = job.pdf, job.id
    monkeypatch.setattr(cli, "async_session_maker", session_factory)
    args = ["recover-report", inc, "--print-job", str(job_id)]
    assert await cli._amain(args) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "ready"
    assert await db_session.get(IncidentArchiveReport, uuid.UUID(inc)) is None
    assert not list(Path(storage_mod._ROOT).rglob("*.pdf"))
    assert await cli._amain([*args, "--apply"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["state"] == "recovered"
    assert result["reversedPages"] is True
    db_session.expire_all()
    kept = await db_session.get(IncidentArchiveReport, uuid.UUID(inc))
    assert kept.composed_at == datetime(2026, 7, 15, tzinfo=UTC)
    key = kept.storage_key
    assert str(job_id) in key
    assert (await _row(db_session, inc)).state == "pending"
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    files = drive.files(f"{REPORTS}/2026/2026.07.15 Ölspur")
    assert len(files) == 1
    assert files[next(iter(files))] == await storage_mod.aget_bytes(key)
    assert await cli._amain(args) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "unchanged"
    assert await archive.run_once(session_factory, transport=drive.transport) is None
    db_session.expire_all()
    assert (await db_session.get(type(job), job_id)).pdf == source
    # A freshly composed Rapport still supersedes the legacy bytes and is filed as v2.
    await _report(client, inc, summary="Nachtrag zum wiederhergestellten Rapport.")
    assert await archive.run_once(session_factory, transport=drive.transport) == "delivered"
    assert len(drive.files(f"{REPORTS}/2026/2026.07.15 Ölspur")) == 2
    assert drive.files()[next(iter(files))] == files[next(iter(files))]


@pytest.mark.parametrize(
    "reason", ["running", "exercise", "off", "wrong-incident", "wrong-kind", "not-done", "newer-report"]
)
async def test_recovery_refuses_unsafe_sources_without_writing(client, editor, drive, db_session, reason):
    from app.admin_incident_archive import recover_report

    inc = await _incident(client, editor, is_exercise=reason == "exercise")
    if reason != "running":
        await _close(client, inc)
    source_inc = await _incident(client, editor) if reason == "wrong-incident" else inc
    job = await _old_print_job(
        db_session,
        source_inc,
        kind="capture_report" if reason == "wrong-kind" else "report",
        status="failed" if reason == "not-done" else "done",
    )
    if reason == "off":
        await _config(db_session, {"enabled": False, "destinations": [DEST]})
    if reason == "newer-report":
        await _report(client, inc)
    with pytest.raises(ValueError):
        await recover_report(db_session, uuid.UUID(inc), job.id, apply=True)
    db_session.expire_all()
    kept = await db_session.get(IncidentArchiveReport, uuid.UUID(inc))
    assert (kept is not None) == (reason == "newer-report")


@pytest.mark.parametrize("remote", [{"reports": [{"sha": "old"}]}, {"reportTry": {"sha": "unconfirmed"}}])
async def test_recovery_protects_previously_filed_and_unconfirmed_reports(client, editor, drive, db_session, remote):
    from app.admin_incident_archive import recover_report

    inc = await _incident(client, editor)
    await _close(client, inc)
    row = await _row(db_session, inc)
    row.remote_items = remote
    job = await _old_print_job(db_session, inc)
    with pytest.raises(ValueError, match=r"already filed|unconfirmed"):
        await recover_report(db_session, uuid.UUID(inc), job.id, apply=True)
    assert await db_session.get(IncidentArchiveReport, uuid.UUID(inc)) is None
    assert not list(Path(storage_mod._ROOT).rglob("*.pdf"))


async def test_recovery_rollback_leaves_no_kept_pdf_or_storage_blob(client, editor, drive, session_factory, db_session):
    from app.admin_incident_archive import recover_report

    inc = await _incident(client, editor)
    await _close(client, inc)
    job = await _old_print_job(db_session, inc)
    async with session_factory() as db:
        result = await recover_report(db, uuid.UUID(inc), job.id, apply=True)
        assert result["state"] == "recovered"
        await db.rollback()
    db_session.expire_all()
    assert await db_session.get(IncidentArchiveReport, uuid.UUID(inc)) is None
    assert not list(Path(storage_mod._ROOT).rglob("*.pdf"))
    assert (await _row(db_session, inc)).wanted == 1


@pytest.mark.parametrize("reversed_pages", [False, True])
def test_recovery_reads_production_footer_with_a_long_title(reversed_pages):
    import io

    from app.admin_incident_archive import reading_order_pdf
    from app.api.print_relay import reverse_pdf_pages
    from app.report.styles import _NumberedCanvas

    buf = io.BytesIO()
    c = _NumberedCanvas(buf)
    c.footer_label = (
        "Brand in einem sehr langen Gebaeudenamen mit ausfuehrlicher Ortsangabe " * 3 + " · 17.11.2026 09:00"
    )
    for n in range(1, 4):
        c.drawString(50, 700, f"Original page {n}")
        c.showPage()
    c.save()
    source = reverse_pdf_pages(buf.getvalue()) if reversed_pages else buf.getvalue()
    pdf, pages, was_reversed = reading_order_pdf(source)
    assert pages == 3
    assert was_reversed is reversed_pages
    import pypdfium2 as pdfium

    from app.pdfium_lock import pdfium_lock

    with pdfium_lock, pdfium.PdfDocument(pdf) as doc:
        for n, page in enumerate(doc, 1):
            with closing(page), closing(page.get_textpage()) as text:
                assert f"Original page {n}" in text.get_text_range()


async def test_recovery_does_not_confirm_a_kept_pdf_missing_from_the_mounted_storage(
    client, editor, drive, session_factory, db_session, monkeypatch, capsys
):
    from app import admin_incident_archive as cli

    inc = await _incident(client, editor)
    await _close(client, inc)
    job = await _old_print_job(db_session, inc)
    monkeypatch.setattr(cli, "async_session_maker", session_factory)
    args = ["recover-report", inc, "--print-job", str(job.id)]
    assert await cli._amain([*args, "--apply"]) == 0
    capsys.readouterr()
    kept = await db_session.get(IncidentArchiveReport, uuid.UUID(inc))
    storage_mod.delete(kept.storage_key)
    assert await cli._amain(args) == 1
    captured = capsys.readouterr()
    assert not captured.out
    assert "MEDIA_STORAGE_DIR" in captured.err
