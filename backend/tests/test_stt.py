"""Speech-to-text drafts (POST /transcribe, GET /transcription, PATCH segments).

The safety contract: fail-closed without a configured engine (503 + sttConfigured=false),
editor-only trigger, drafts land as per-segment 'open' status, confirmation stamps the
created journal row id, and a job orphaned by a server restart reports 'failed' instead of
spinning forever. The engine adapter itself is exercised against a mocked HTTP layer in
the transcribe() unit tests.
"""

import asyncio
import uuid

import pytest

import app.api.media as media_api
import app.audio as audio_mod
import app.storage as storage_mod
from app.config import settings

M4A = b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00M4A mp42isom\x00\x00\x00\x00" + b"audiodata"


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


@pytest.fixture(autouse=True)
def _reset_stt_globals():
    """Give every test a fresh, loop-unbound STT semaphore + empty in-flight task maps.

    `_stt_gate` / `_stt_tasks` / `_peaks_jobs` are module-globals that outlive a single test.
    pytest-asyncio hands each test its own event loop, and an ``asyncio.Semaphore`` binds to
    the first loop that awaits it — so a later test on a *different* loop hits "bound to a
    different event loop" inside ``async with _stt_gate``, which ``_run_stt`` swallows as an
    "Unerwarteter Fehler" and the job lands as ``failed`` instead of ``done``. That's invisible
    locally (the loop gets reused) but red in CI, where it isn't. Recreating the semaphore per
    test (and clearing/cancelling any leaked tasks) removes the whole cross-loop leak class.
    In production this never bites: one process, one loop for the app's lifetime."""
    media_api._stt_gate = asyncio.Semaphore(1)
    media_api._stt_tasks.clear()
    media_api._peaks_jobs.clear()
    yield
    for task in list(media_api._stt_tasks.values()) + list(media_api._peaks_jobs.values()):
        task.cancel()
    media_api._stt_tasks.clear()
    media_api._peaks_jobs.clear()


@pytest.fixture()
def stt_configured(monkeypatch, session_factory):
    monkeypatch.setattr(settings, "stt_base_url", "https://stt.example")
    # the background job opens its own session — point it at the test loop's factory
    import app.database as database_mod
    monkeypatch.setattr(database_mod, "async_session_maker", session_factory)


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _upload_audio(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Test Einsatz"})
    inc = r.json()["id"]
    r = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("memo.m4a", M4A, "audio/mp4")},
        data={"kind": "audio"},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _poll_done(client, media_id, tries=100):
    for _ in range(tries):
        r = await client.get(f"/api/media/{media_id}/transcription")
        if r.json()["status"] in ("done", "failed"):
            return r.json()
        await asyncio.sleep(0.02)
    raise AssertionError("stt job never finished")


async def test_unconfigured_engine_is_503_and_flagged(client, editor, monkeypatch):
    # force-unset: the developer's local .env may configure a real engine
    monkeypatch.setattr(settings, "stt_base_url", "")
    await _login(client, editor)
    media_id = await _upload_audio(client)
    r = await client.post(f"/api/media/{media_id}/transcribe")
    assert r.status_code == 503
    cfg = await client.get("/api/config")
    assert cfg.json()["integrations"]["sttConfigured"] is False


async def test_transcribe_roundtrip_and_confirm(client, editor, stt_configured, monkeypatch):
    async def fake_transcribe(_path):
        return [
            {"start": 240.0, "end": 251.0, "text": "Trupp 1 an Front: Zimmerbrand Küche."},
            {"start": 900.0, "end": 905.5, "text": "Front an Ambulanz: Übergabe Patientin."},
        ]
    monkeypatch.setattr(audio_mod, "transcribe", fake_transcribe)
    await _login(client, editor)
    media_id = await _upload_audio(client)

    assert (await client.get("/api/config")).json()["integrations"]["sttConfigured"] is True
    r = await client.post(f"/api/media/{media_id}/transcribe")
    assert r.status_code == 202
    body = await _poll_done(client, media_id)
    assert body["status"] == "done"
    assert [s["status"] for s in body["segments"]] == ["open", "open"]

    # confirm the first draft with the journal row the client created
    p = await client.patch(
        f"/api/media/{media_id}/transcription/segments/0",
        json={"status": "confirmed", "rowId": "e123-p0"},
    )
    assert p.status_code == 200
    body = (await client.get(f"/api/media/{media_id}/transcription")).json()
    assert body["segments"][0] == {
        "start": 240.0, "end": 251.0, "text": "Trupp 1 an Front: Zimmerbrand Küche.",
        "status": "confirmed", "rowId": "e123-p0",
    }
    # post-confirm text correction stays possible and syncs to the segment
    p = await client.patch(
        f"/api/media/{media_id}/transcription/segments/0",
        json={"status": "confirmed", "text": "Trupp 1 an Front: Zimmerbrand Küche, korrigiert."},
    )
    assert p.status_code == 200
    body = (await client.get(f"/api/media/{media_id}/transcription")).json()
    assert body["segments"][0]["text"].endswith("korrigiert.")
    assert body["segments"][0]["rowId"] == "e123-p0"  # earlier rowId survives
    # dismiss the second
    p = await client.patch(
        f"/api/media/{media_id}/transcription/segments/1", json={"status": "dismissed"}
    )
    assert p.status_code == 200
    # out of range → 404
    p = await client.patch(
        f"/api/media/{media_id}/transcription/segments/2", json={"status": "dismissed"}
    )
    assert p.status_code == 404


async def test_engine_failure_lands_as_failed(client, editor, stt_configured, monkeypatch):
    async def boom(_path):
        raise audio_mod.SttError("STT-Server: HTTP 500")
    monkeypatch.setattr(audio_mod, "transcribe", boom)
    await _login(client, editor)
    media_id = await _upload_audio(client)
    await client.post(f"/api/media/{media_id}/transcribe")
    body = await _poll_done(client, media_id)
    assert body["status"] == "failed"
    assert "HTTP 500" in body["error"]
    # a re-run replaces the failed job
    async def ok(_path):
        return [{"start": 0.0, "end": 1.0, "text": "Neu."}]
    monkeypatch.setattr(audio_mod, "transcribe", ok)
    assert (await client.post(f"/api/media/{media_id}/transcribe")).status_code == 202
    body = await _poll_done(client, media_id)
    assert body["status"] == "done"


async def test_viewer_reads_but_cannot_trigger_or_patch(client, editor, viewer, stt_configured, monkeypatch):
    async def fake(_path):
        return [{"start": 0.0, "end": 1.0, "text": "x"}]
    monkeypatch.setattr(audio_mod, "transcribe", fake)
    await _login(client, editor)
    media_id = await _upload_audio(client)
    await client.post(f"/api/media/{media_id}/transcribe")
    await _poll_done(client, media_id)

    await _login(client, viewer)
    assert (await client.get(f"/api/media/{media_id}/transcription")).status_code == 200
    assert (await client.post(f"/api/media/{media_id}/transcribe")).status_code == 403
    r = await client.patch(
        f"/api/media/{media_id}/transcription/segments/0", json={"status": "confirmed"}
    )
    assert r.status_code == 403


async def test_orphaned_running_job_reports_failed(client, editor, stt_configured, monkeypatch):
    """Status 'running' in the DB but no in-process task = server restarted mid-job."""
    async def fake(_path):
        return [{"start": 0.0, "end": 1.0, "text": "x"}]
    monkeypatch.setattr(audio_mod, "transcribe", fake)
    await _login(client, editor)
    media_id = await _upload_audio(client)
    await client.post(f"/api/media/{media_id}/transcribe")
    await _poll_done(client, media_id)
    # simulate the restart: force the row back to running with no registered task
    from sqlalchemy import update

    import app.database as database_mod
    from app.models import SttJob

    async with database_mod.async_session_maker() as db:
        await db.execute(update(SttJob).values(status="running"))
        await db.commit()
    media_api._stt_tasks.clear()
    body = (await client.get(f"/api/media/{media_id}/transcription")).json()
    assert body["status"] == "failed"
    assert "Serverneustart" in body["error"]


async def test_transcribe_unknown_media_404(client, editor, stt_configured):
    await _login(client, editor)
    assert (await client.post(f"/api/media/{uuid.uuid4()}/transcribe")).status_code == 404


async def test_repeat_transcribe_represents_without_engine_rerun(client, editor, stt_configured, monkeypatch):
    """Tapping Transkribieren on a finished job returns the existing segments directly
    (200, POST → cache-immune), re-opens dismissed ones, keeps confirmed ones confirmed,
    and does NOT call the engine again."""
    calls = 0
    async def fake(_path):
        nonlocal calls
        calls += 1
        return [
            {"start": 1.0, "end": 2.0, "text": "eins"},
            {"start": 3.0, "end": 4.0, "text": "zwei"},
        ]
    monkeypatch.setattr(audio_mod, "transcribe", fake)
    await _login(client, editor)
    media_id = await _upload_audio(client)
    assert (await client.post(f"/api/media/{media_id}/transcribe")).status_code == 202
    await _poll_done(client, media_id)
    await client.patch(f"/api/media/{media_id}/transcription/segments/0",
                       json={"status": "confirmed", "rowId": "e1-p0"})
    await client.patch(f"/api/media/{media_id}/transcription/segments/1",
                       json={"status": "dismissed"})

    r = await client.post(f"/api/media/{media_id}/transcribe")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "done"
    assert body["segments"][0]["status"] == "confirmed"   # never re-opened (dupe guard)
    assert body["segments"][1]["status"] == "open"        # dismissed → suggested again
    assert calls == 1  # the engine ran exactly once


async def test_api_json_is_no_store_but_media_stays_cacheable(client, editor):
    """Safari's heuristic cache hid finished jobs — API JSON now says no-store explicitly;
    streamed media keeps normal caching (range requests / repeat playback)."""
    cfg = await client.get("/api/config")
    assert cfg.headers.get("cache-control") == "no-store"
    await _login(client, editor)
    media_id = await _upload_audio(client)
    served = await client.get(f"/api/media/{media_id}")
    assert served.headers.get("cache-control") != "no-store"


async def test_delete_transcription_resets_to_none(client, editor, viewer, stt_configured, monkeypatch):
    async def fake(_path):
        return [{"start": 0.0, "end": 1.0, "text": "x"}]
    monkeypatch.setattr(audio_mod, "transcribe", fake)
    await _login(client, editor)
    media_id = await _upload_audio(client)
    await client.post(f"/api/media/{media_id}/transcribe")
    await _poll_done(client, media_id)

    # viewers cannot discard working data
    await _login(client, viewer)
    assert (await client.delete(f"/api/media/{media_id}/transcription")).status_code == 403

    await _login(client, editor)
    assert (await client.delete(f"/api/media/{media_id}/transcription")).status_code == 200
    body = (await client.get(f"/api/media/{media_id}/transcription")).json()
    assert body["status"] == "none"
    # a second delete has nothing to remove
    assert (await client.delete(f"/api/media/{media_id}/transcription")).status_code == 404
    # and Transkribieren can run fresh
    assert (await client.post(f"/api/media/{media_id}/transcribe")).status_code == 202
    body = await _poll_done(client, media_id)
    assert body["status"] == "done", body  # DIAGNOSTIC: surface job.error on the CI-only failure


async def test_transcribe_adapter_parses_verbose_json(monkeypatch, tmp_path):
    """The adapter unit: re-encode is stubbed, the HTTP layer is faked, and the
    verbose_json segments come back trimmed with empty ones dropped."""
    monkeypatch.setattr(settings, "stt_base_url", "https://stt.example")
    monkeypatch.setattr(settings, "stt_api_key", "k")

    async def fake_reencode(_src, dst):
        with open(dst, "wb") as fh:
            fh.write(b"ogg")
    monkeypatch.setattr(audio_mod, "reencode_for_stt", fake_reencode)

    class FakeResponse:
        status_code = 200
        def json(self):
            return {"text": "alles", "segments": [
                {"start": 1.0, "end": 2.0, "text": "  Hallo.  "},
                {"start": 2.0, "end": 3.0, "text": "   "},
            ]}

    class FakeClient:
        def __init__(self, **_kw): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *_a): return False
        async def post(self, url, **kw):
            assert url == "https://stt.example/v1/audio/transcriptions"
            assert kw["headers"]["Authorization"] == "Bearer k"
            assert kw["data"]["response_format"] == "verbose_json"
            return FakeResponse()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    src = tmp_path / "in.m4a"
    src.write_bytes(b"x")
    segs = await audio_mod.transcribe(str(src))
    assert segs == [{"start": 1.0, "end": 2.0, "text": "Hallo."}]
