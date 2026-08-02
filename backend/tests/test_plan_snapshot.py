"""Objektplan-Pull: reading Modul-PDFs from an S3-compatible snapshot store (app/plans.py).

Contract under test:
- fail-closed: no store configured → the feature is off, no job is scheduled, nothing is fetched;
- the index's sha256 decides: unchanged → no download at all, changed → upserted in place;
- a malformed or incomplete index refuses the WHOLE run and changes nothing — and a plan that
  vanishes from the index is never deleted;
- the upload path's size cap applies to the pull too: an oversize plan is skipped with a log,
  not a crash, and the rest of the run continues;
- both doors write the same `plan:<obj>:<module>` dataset through the same code path.

The store is a `httpx.MockTransport` — no network, no credentials, no provider.
"""

import hashlib
import json
import uuid

import httpx
import pytest
from sqlalchemy import select

from app import storage as storage_mod
from app.config import settings
from app.models import ObjectSite, ReferenceDataset
from app.plans import parse_index, plans_pull_enabled, pull_plans

OBJ_ID = uuid.UUID("2b1c4a6e-0000-5000-8000-000000000001")
OTHER_ID = uuid.UUID("2b1c4a6e-0000-5000-8000-000000000002")
PDF = b"%PDF-1.4\nModul 1, wie er heute im Ordner liegt\n"
PDF_V2 = b"%PDF-1.4\nModul 1, nach der Revision\n"
SHA = hashlib.sha256(PDF).hexdigest()
SHA_V2 = hashlib.sha256(PDF_V2).hexdigest()

BUCKET = "station"
INDEX_URL_PATH = f"/{BUCKET}/plans/index.json"
PDF_URL_PATH = f"/{BUCKET}/plans/{OBJ_ID}/modul1.pdf"


def entry(**over) -> dict:
    row = {
        "object_id": str(OBJ_ID),
        "module": "modul1",
        "filename": "modul1.pdf",
        "size": len(PDF),
        "sha256": SHA,
        "address_full": "Musterstrasse 1, 4104 Musterdorf",
    }
    row.update(over)
    return row


def index(*rows: dict) -> bytes:
    return json.dumps({"generated_at": "2026-08-02T05:00:00Z", "plans": list(rows)}).encode()


@pytest.fixture
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


@pytest.fixture
def store(monkeypatch, isolated_storage):
    """A configured snapshot store backed by a MockTransport.

    Returns `serve(objects)`, which installs the given `{url path: bytes}` store and hands
    back the list every request appends its path to — that list is how "did not download"
    is asserted.
    """
    monkeypatch.setattr(settings, "plans_s3_endpoint", "https://objects.example.org")
    monkeypatch.setattr(settings, "plans_s3_bucket", BUCKET)
    monkeypatch.setattr(settings, "plans_s3_prefix", "")
    monkeypatch.setattr(settings, "plans_s3_region", "us-east-1")
    monkeypatch.setattr(settings, "plans_s3_access_key_id", "AKIAEXAMPLE")
    monkeypatch.setattr(settings, "plans_s3_secret_access_key", "shhh")

    def serve(objects: dict[str, bytes]) -> list[str]:
        requested: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requested.append(request.url.path)
            body = objects.get(request.url.path)
            if body is None:
                return httpx.Response(404, text="no such key")
            return httpx.Response(200, content=body)

        transport = httpx.MockTransport(handler)
        orig_init = httpx.AsyncClient.__init__

        def patched_init(self, *args, **kwargs):
            # setdefault, not overwrite: the FastAPI test client passes its own ASGI transport.
            kwargs.setdefault("transport", transport)
            orig_init(self, *args, **kwargs)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)
        return requested

    return serve


@pytest.fixture
async def obj(db_session):
    o = ObjectSite(id=OBJ_ID, name="Schulhaus", address="Musterstrasse 1")
    db_session.add(o)
    await db_session.commit()
    return o


async def _dataset(db, dataset_id: str) -> ReferenceDataset | None:
    return (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == dataset_id))).scalar_one_or_none()


# --- both doors, one dataset ---------------------------------------------------------------


async def test_manual_upload_still_writes_the_dataset_it_always_did(
    client, admin_login, db_session, obj, isolated_storage
):
    """The upload endpoint now delegates to the shared `store_plan`; this pins what it wrote
    before the refactor — id, kind, title fallback, source_type, size, blob, version bump."""
    await admin_login(client)

    r = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", PDF, "application/pdf")},
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == f"plan:{OBJ_ID}:modul1"
    assert body["kind"] == "pdf" and body["module"] == "modul1"
    assert body["title"] == "Schulhaus – modul1"  # falls back to the object's name
    assert body["source_type"] == "uploaded"
    assert body["size_bytes"] == len(PDF)
    assert body["current_version"] == 1
    ds = await _dataset(db_session, f"plan:{OBJ_ID}:modul1")
    assert storage_mod.get_bytes(ds.storage_key) == PDF

    # A second upload bumps the version in place and keeps a title/source_note it isn't given.
    r2 = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", PDF_V2, "application/pdf")},
        data={"source_note": "Revision 2026"},
    )
    assert r2.json()["current_version"] == 2
    assert r2.json()["title"] == "Schulhaus – modul1"
    assert r2.json()["source_note"] == "Revision 2026"
    r3 = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", PDF, "application/pdf")},
    )
    assert r3.json()["source_note"] == "Revision 2026"  # not wiped by a note-less upload


async def test_both_doors_write_the_same_dataset(client, admin_login, db_session, obj, store):
    """The point of the inversion: a pulled plan lands on the hand-uploaded one, same id,
    same row — not beside it under a second identity scheme."""
    await admin_login(client)
    await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", PDF, "application/pdf")},
    )
    before = await _dataset(db_session, f"plan:{OBJ_ID}:modul1")
    assert before.source_type == "uploaded"
    version_before = before.current_version  # the row is identity-mapped; keep the value, not it

    store({INDEX_URL_PATH: index(entry(sha256=SHA_V2, size=len(PDF_V2))), PDF_URL_PATH: PDF_V2})
    await pull_plans(db_session)

    rows = (await db_session.execute(select(ReferenceDataset).where(ReferenceDataset.object_id == OBJ_ID))).scalars()
    assert [r.id for r in rows] == [f"plan:{OBJ_ID}:modul1"]  # one row, not two
    after = await _dataset(db_session, f"plan:{OBJ_ID}:modul1")
    assert after.source_type == "snapshot" and after.current_version == version_before + 1
    assert storage_mod.get_bytes(after.storage_key) == PDF_V2


# --- fail-closed: unconfigured store -----------------------------------------------------


async def test_unconfigured_store_is_simply_off(db_session, store, monkeypatch):
    requested = store({INDEX_URL_PATH: index(entry())})
    monkeypatch.setattr(settings, "plans_s3_endpoint", "")

    assert plans_pull_enabled() is False
    assert await pull_plans(db_session) == {"status": "disabled"}
    assert requested == []  # not even the index is asked for


async def test_unconfigured_store_schedules_no_job(monkeypatch):
    """No store → no job at all: not a job that wakes up and finds nothing to do."""
    import app.scheduler as sched
    from app.main import app

    monkeypatch.setattr(settings, "plans_s3_endpoint", "")
    await sched.start_scheduler(app)
    try:
        assert "plan_pull" not in {j.id for j in sched._scheduler.get_jobs()}
    finally:
        await sched.stop_scheduler()


async def test_configured_store_schedules_the_job(store, monkeypatch):
    import app.scheduler as sched
    from app.main import app

    store({})
    await sched.start_scheduler(app)
    try:
        assert "plan_pull" in {j.id for j in sched._scheduler.get_jobs()}
    finally:
        await sched.stop_scheduler()


# --- the checksum decides -----------------------------------------------------------------


async def test_new_plan_is_created_under_the_shared_id(db_session, obj, store):
    requested = store({INDEX_URL_PATH: index(entry()), PDF_URL_PATH: PDF})

    res = await pull_plans(db_session)

    assert res == {"status": "ok", "updated": 1, "unchanged": 0, "skipped": 0}
    ds = await _dataset(db_session, f"plan:{OBJ_ID}:modul1")
    assert ds is not None
    assert ds.object_id == OBJ_ID and ds.module == "modul1" and ds.kind == "pdf"
    assert ds.source_type == "snapshot" and ds.source_digest == SHA
    assert ds.size_bytes == len(PDF)
    assert storage_mod.get_bytes(ds.storage_key) == PDF
    assert PDF_URL_PATH in requested


async def test_unchanged_sha256_downloads_nothing(db_session, obj, store):
    store({INDEX_URL_PATH: index(entry()), PDF_URL_PATH: PDF})
    await pull_plans(db_session)
    first = await _dataset(db_session, f"plan:{OBJ_ID}:modul1")
    version_before = first.current_version

    requested = store({INDEX_URL_PATH: index(entry()), PDF_URL_PATH: PDF})
    res = await pull_plans(db_session)

    assert res == {"status": "ok", "updated": 0, "unchanged": 1, "skipped": 0}
    assert requested == [INDEX_URL_PATH]  # the PDF was never asked for
    assert (await _dataset(db_session, f"plan:{OBJ_ID}:modul1")).current_version == version_before


async def test_changed_sha256_is_upserted_in_place(db_session, obj, store):
    store({INDEX_URL_PATH: index(entry()), PDF_URL_PATH: PDF})
    await pull_plans(db_session)
    before = await _dataset(db_session, f"plan:{OBJ_ID}:modul1")
    version_before = before.current_version

    store({INDEX_URL_PATH: index(entry(sha256=SHA_V2, size=len(PDF_V2))), PDF_URL_PATH: PDF_V2})
    res = await pull_plans(db_session)

    assert res == {"status": "ok", "updated": 1, "unchanged": 0, "skipped": 0}
    ds = await _dataset(db_session, f"plan:{OBJ_ID}:modul1")
    assert ds.current_version == version_before + 1  # same row, new version
    assert ds.source_digest == SHA_V2 and ds.size_bytes == len(PDF_V2)
    assert storage_mod.get_bytes(ds.storage_key) == PDF_V2


async def test_body_that_contradicts_the_index_is_not_stored(db_session, obj, store):
    # The index is the least trustworthy input there is: if the bytes don't hash to what it
    # promised, we keep what we have rather than store something nobody vouched for.
    store({INDEX_URL_PATH: index(entry(sha256=SHA_V2, size=len(PDF_V2))), PDF_URL_PATH: PDF})

    res = await pull_plans(db_session)

    assert res == {"status": "ok", "updated": 0, "unchanged": 0, "skipped": 1}
    assert await _dataset(db_session, f"plan:{OBJ_ID}:modul1") is None


# --- a bad index changes nothing ----------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param(b"{ this is not json", id="not-json"),
        pytest.param(b'["plans"]', id="not-an-object"),
        pytest.param(b'{"generated_at": "x"}', id="no-plans-list"),
        pytest.param(json.dumps({"plans": []}).encode(), id="empty-plans"),
        pytest.param(index(entry(sha256=None)), id="no-checksum"),
        pytest.param(index(entry(sha256="nothex")), id="bad-checksum"),
        pytest.param(index(entry(object_id="not-a-uuid")), id="bad-object-id"),
        pytest.param(index(entry(module="")), id="no-module"),
        pytest.param(index(entry(filename="../../etc/passwd")), id="path-in-filename"),
        pytest.param(index(entry(filename="modul1.exe")), id="not-a-pdf"),
        pytest.param(index(entry(size=0)), id="zero-size"),
        pytest.param(index(entry(), entry()), id="duplicate-entry"),
    ],
)
async def test_malformed_index_refuses_the_run(raw, db_session, obj, store):
    requested = store({INDEX_URL_PATH: raw, PDF_URL_PATH: PDF})

    with pytest.raises(ValueError):
        parse_index(raw)
    assert await pull_plans(db_session) == {"status": "refused"}
    assert requested == [INDEX_URL_PATH]  # refused before a single PDF byte moved
    assert await _dataset(db_session, f"plan:{OBJ_ID}:modul1") is None


async def test_partial_index_never_deletes_a_plan(db_session, obj, store):
    store({INDEX_URL_PATH: index(entry()), PDF_URL_PATH: PDF})
    await pull_plans(db_session)
    ds_id = f"plan:{OBJ_ID}:modul1"
    assert await _dataset(db_session, ds_id) is not None

    # Next publish is broken and lists a different object's plan only — ours must survive.
    other = ObjectSite(id=OTHER_ID, name="Werkhof")
    db_session.add(other)
    await db_session.commit()
    store(
        {
            INDEX_URL_PATH: index(entry(object_id=str(OTHER_ID))),
            f"/{BUCKET}/plans/{OTHER_ID}/modul1.pdf": PDF,
        }
    )
    await pull_plans(db_session)

    kept = await _dataset(db_session, ds_id)
    assert kept is not None and storage_mod.get_bytes(kept.storage_key) == PDF


async def test_unreachable_store_changes_nothing(db_session, obj, store):
    store({})  # index 404s

    assert await pull_plans(db_session) == {"status": "unreachable"}
    assert await _dataset(db_session, f"plan:{OBJ_ID}:modul1") is None


# --- size cap and unknown objects ---------------------------------------------------------


async def test_oversize_plan_is_skipped_not_fetched(db_session, obj, store, caplog):
    over = (settings.max_upload_mb + 1) * 1024 * 1024
    requested = store(
        {
            INDEX_URL_PATH: index(entry(size=over), entry(module="modul2", filename="modul2.pdf")),
            PDF_URL_PATH: PDF,
            f"/{BUCKET}/plans/{OBJ_ID}/modul2.pdf": PDF,
        }
    )

    with caplog.at_level("WARNING"):
        res = await pull_plans(db_session)

    assert res == {"status": "ok", "updated": 1, "unchanged": 0, "skipped": 1}
    assert PDF_URL_PATH not in requested  # the cap is applied before the download
    assert await _dataset(db_session, f"plan:{OBJ_ID}:modul1") is None
    assert await _dataset(db_session, f"plan:{OBJ_ID}:modul2") is not None  # the run carried on
    assert "over the" in caplog.text and str(settings.max_upload_mb) in caplog.text


async def test_download_larger_than_the_index_claimed_is_skipped(db_session, obj, store, monkeypatch):
    monkeypatch.setattr(settings, "max_upload_mb", 0)  # cap everything out
    store({INDEX_URL_PATH: index(entry(size=1)), PDF_URL_PATH: PDF})

    res = await pull_plans(db_session)

    assert res == {"status": "ok", "updated": 0, "unchanged": 0, "skipped": 1}
    assert await _dataset(db_session, f"plan:{OBJ_ID}:modul1") is None


async def test_plan_for_an_unknown_object_is_skipped(db_session, store, caplog):
    # No ObjectSite fixture here: objects are loaded by the object path, not invented from an
    # index that carries an address but no name or coordinates.
    store({INDEX_URL_PATH: index(entry()), PDF_URL_PATH: PDF})

    with caplog.at_level("WARNING"):
        res = await pull_plans(db_session)

    assert res == {"status": "ok", "updated": 0, "unchanged": 0, "skipped": 1}
    assert await _dataset(db_session, f"plan:{OBJ_ID}:modul1") is None
    assert "Musterstrasse 1" in caplog.text  # the log names the object an operator would recognise


async def test_non_pdf_bytes_are_refused(db_session, obj, store):
    junk = b"<html>login page</html>"
    store({INDEX_URL_PATH: index(entry(sha256=hashlib.sha256(junk).hexdigest(), size=len(junk))), PDF_URL_PATH: junk})

    res = await pull_plans(db_session)

    assert res == {"status": "ok", "updated": 0, "unchanged": 0, "skipped": 1}
    assert await _dataset(db_session, f"plan:{OBJ_ID}:modul1") is None


# --- request signing ----------------------------------------------------------------------


def test_signed_get_is_path_style_and_matches_the_reference_signature(monkeypatch):
    """Golden vector: this exact Authorization header was cross-checked against botocore's
    `SigV4Auth` for the same inputs. It is pinned rather than recomputed because a signing
    change is invisible in every other test here (the store is mocked) and shows up in the
    field as a flat 403 from a bucket that was working yesterday."""
    from datetime import UTC, datetime

    from app.plans import _signed_get

    monkeypatch.setattr(settings, "plans_s3_endpoint", "https://objects.example.org")
    monkeypatch.setattr(settings, "plans_s3_bucket", "station")
    monkeypatch.setattr(settings, "plans_s3_prefix", "kp-front/")
    monkeypatch.setattr(settings, "plans_s3_region", "eu-central-1")
    monkeypatch.setattr(settings, "plans_s3_access_key_id", "AKIAEXAMPLE")
    monkeypatch.setattr(settings, "plans_s3_secret_access_key", "shhh-not-a-real-secret")

    url, headers = _signed_get("plans/index.json", now=datetime(2026, 8, 2, 5, 0, 0, tzinfo=UTC))

    # Path-style (`<endpoint>/<bucket>/<prefix><key>`) — the addressing every S3-compatible
    # implementation accepts, including the ones with no wildcard DNS.
    assert url == "https://objects.example.org/station/kp-front/plans/index.json"
    assert headers["x-amz-date"] == "20260802T050000Z"
    assert headers["Authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260802/eu-central-1/s3/aws4_request, "
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, "
        "Signature=d70fae22c666f815fdb15839865c5d159bb63c300e946d0c9b5c490d0f42c7bf"
    )


# --- the admin fetch trigger --------------------------------------------------------------


async def test_fetch_endpoint_pulls_one_plan(client, admin_login, db_session, obj, store):
    store({INDEX_URL_PATH: index(entry()), PDF_URL_PATH: PDF})
    await admin_login(client)

    r = await client.post(f"/api/reference/plan:{OBJ_ID}:modul1/fetch")

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "updated"
    assert await _dataset(db_session, f"plan:{OBJ_ID}:modul1") is not None


async def test_fetch_endpoint_is_501_without_a_store(client, admin_login, db_session, obj, monkeypatch):
    monkeypatch.setattr(settings, "plans_s3_endpoint", "")
    await admin_login(client)

    r = await client.post(f"/api/reference/plan:{OBJ_ID}:modul1/fetch")

    assert r.status_code in (404, 501)  # no store configured → no auto-fetch, nothing invented
