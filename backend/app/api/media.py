"""Media: upload photos/audio to object storage, stream them back (auth required).

The workspace blob references a media id/URL instead of an inline blob, so history keeps
the file. Returned URL is same-origin (`/api/media/{id}`).
"""

import asyncio
import json
import logging
import mimetypes
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import audio, database, storage
from ..auth.dependencies import CurrentEditor, CurrentUser
from ..config import settings
from ..database import get_db
from ..models import Incident, Media, SttJob

router = APIRouter(tags=["media"])
logger = logging.getLogger(__name__)

_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
        "audio/webm": ".webm", "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
        "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a"}

# Allowlist: only the image/audio types we know how to store and serve back. Anything else
# (executables, html, octet-stream) is rejected with 415 so a stored blob can't be a vector.
# The M4A trio covers Apple Voice Memos exports across inconsistent browser MIME labelling.
_ALLOWED_PHOTO = {"image/jpeg", "image/png", "image/webp"}
_ALLOWED_AUDIO = {"audio/webm", "audio/mpeg", "audio/ogg", "audio/wav",
                  "audio/mp4", "audio/x-m4a", "audio/m4a"}
_M4A_TYPES = {"audio/mp4", "audio/x-m4a", "audio/m4a"}

# External Voice Memos can be hours long — stream to disk in chunks (never file.read() the
# whole body into memory) and cap the size. Cap is a module constant so tests can shrink it.
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
_CHUNK = 1024 * 1024


def _looks_like_isobmff(head: bytes) -> bool:
    """M4A is an ISO-BMFF container: box size (4 bytes) then the literal 'ftyp'."""
    return len(head) >= 12 and head[4:8] == b"ftyp"


@router.post("/incidents/{incident_id}/media", status_code=201)
async def upload_media(
    incident_id: uuid.UUID,
    user: CurrentEditor,
    file: UploadFile = File(...),
    kind: str = Form(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if kind not in ("photo", "audio"):
        raise HTTPException(status_code=422, detail="kind muss 'photo' oder 'audio' sein")
    inc = (await db.execute(select(Incident.id).where(Incident.id == incident_id))).scalar_one_or_none()
    if inc is None:
        raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")

    content_type = file.content_type or "application/octet-stream"
    allowed = _ALLOWED_PHOTO if kind == "photo" else _ALLOWED_AUDIO
    if content_type not in allowed:
        raise HTTPException(
            status_code=415,
            detail=f"Dateityp {content_type!r} nicht erlaubt (erwartet: {', '.join(sorted(allowed))})",
        )
    # Peek the first chunk before allocating storage: a file merely *named* .m4a (or a
    # mislabelled octet-stream) must not be stored, so verify the ISO-BMFF signature here.
    first = await file.read(_CHUNK)
    if content_type in _M4A_TYPES and not _looks_like_isobmff(first):
        raise HTTPException(status_code=415, detail="Datei ist keine gültige M4A-Aufnahme")

    ext = _EXT.get(content_type) or mimetypes.guess_extension(content_type) or ""
    key = storage.new_key(f"media/{incident_id}", ext)

    async def _chunks():
        chunk = first
        while chunk:
            yield chunk
            chunk = await file.read(_CHUNK)

    try:
        await storage.put_astream(key, _chunks(), max_bytes=MAX_UPLOAD_BYTES)
    except storage.TooLargeError:
        raise HTTPException(
            status_code=413,
            detail=f"Datei zu gross (Maximum {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
        ) from None

    # The DB row exists only after a complete, size-checked write — an aborted upload leaves
    # neither a partial blob (put_astream cleans up) nor a dangling Media record.
    media = Media(incident_id=incident_id, kind=kind, storage_key=key,
                  content_type=content_type, created_by=user.id)
    db.add(media)
    await db.flush()
    return {"id": str(media.id), "url": f"/api/media/{media.id}", "kind": kind, "content_type": content_type}


@router.get("/media/{media_id}")
async def get_media(media_id: uuid.UUID, _user: CurrentUser, db: AsyncSession = Depends(get_db)) -> FileResponse:
    media = (await db.execute(select(Media).where(Media.id == media_id))).scalar_one_or_none()
    if media is None or not storage.exists(media.storage_key):
        raise HTTPException(status_code=404, detail="Medium nicht gefunden")
    return FileResponse(storage.local_path(media.storage_key), media_type=media.content_type or None)


# Waveform peaks. Lazily computed once per
# recording, cached next to the blob, single-flight per media id. A failed/impossible
# extraction caches {"peaks": null} — the player falls back to a flat bar, never an error.
_peaks_jobs: dict[str, asyncio.Task] = {}


@router.get("/media/{media_id}/peaks")
async def get_peaks(media_id: uuid.UUID, _user: CurrentUser, db: AsyncSession = Depends(get_db)) -> JSONResponse:
    media = (await db.execute(select(Media).where(Media.id == media_id))).scalar_one_or_none()
    if media is None or media.kind != "audio" or not storage.exists(media.storage_key):
        raise HTTPException(status_code=404, detail="Medium nicht gefunden")
    pkey = audio.peaks_key(media.storage_key)
    if storage.exists(pkey):
        return JSONResponse(json.loads(storage.get_bytes(pkey)))
    job_id = str(media_id)
    task = _peaks_jobs.get(job_id)
    if task is None or task.done():
        task = asyncio.create_task(audio.compute_and_store_peaks(media.storage_key))
        _peaks_jobs[job_id] = task
        task.add_done_callback(lambda _t: _peaks_jobs.pop(job_id, None))
    return JSONResponse({"status": "pending"}, status_code=202)


# ---- Speech-to-text drafts --------------------------------------------------------
# Segments are DRAFTS the operator reviews in the player; confirming appends an ordinary
# journal row client-side and PATCHes the segment status back here. Fail-closed: without
# a configured engine (env stt_base_url) the trigger endpoint answers 503 and the client
# never shows the button (integrations.sttConfigured).

_stt_tasks: dict[str, asyncio.Task] = {}
_stt_gate = asyncio.Semaphore(1)  # one engine call at a time on the single instance


async def _run_stt(media_id: uuid.UUID, storage_key: str) -> None:
    async with _stt_gate:
        try:
            segments = await audio.transcribe(storage.local_path(storage_key))
            status, error = "done", None
            payload = [{**s, "status": "open"} for s in segments]
        except audio.SttError as e:
            status, error, payload = "failed", str(e), None
        except Exception:  # noqa: BLE001 — a crashed job must land as 'failed', not vanish
            logger.exception("STT job crashed for media %s", media_id)  # keep the detail server-side
            status, error, payload = "failed", "Unerwarteter Fehler", None
        # resolved through the module so tests can point it at their loop-local factory
        async with database.async_session_maker() as db:
            job = (await db.execute(select(SttJob).where(SttJob.media_id == media_id))).scalar_one_or_none()
            if job is None:
                return
            job.status, job.error, job.segments = status, error, payload
            job.finished_at = datetime.now(UTC)
            await db.commit()


@router.post("/media/{media_id}/transcribe")
async def start_transcription(
    media_id: uuid.UUID, user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> JSONResponse:
    """First run → fresh engine call (202 + poll). An already-finished job → 200 with the
    existing segments, dismissed ones re-opened: tapping Transkribieren again re-presents
    the suggestions instead of returning nothing — and because POST responses are never
    HTTP-cached, this path also survives clients with a stale cached status GET. Confirmed
    segments stay confirmed (re-opening them would invite duplicate journal rows)."""
    if not settings.stt_base_url:
        raise HTTPException(status_code=503, detail="Kein STT-Server konfiguriert")
    media = (await db.execute(select(Media).where(Media.id == media_id))).scalar_one_or_none()
    if media is None or media.kind != "audio" or not storage.exists(media.storage_key):
        raise HTTPException(status_code=404, detail="Medium nicht gefunden")
    job = (await db.execute(select(SttJob).where(SttJob.media_id == media_id))).scalar_one_or_none()
    key = str(media_id)
    if job is not None and job.status in ("queued", "running") and key in _stt_tasks:
        return JSONResponse({"status": job.status}, status_code=202)
    if job is not None and job.status == "done" and job.segments is not None:
        segments = [
            {**s, "status": "open"} if s.get("status") == "dismissed" else dict(s)
            for s in job.segments
        ]
        job.segments = segments
        await db.flush()
        return JSONResponse({"status": "done", "segments": segments})
    if job is None:
        job = SttJob(media_id=media_id)
        db.add(job)
    # a failed (or vanished) run is replaced by a fresh one (drafts are working data)
    job.status, job.error, job.segments, job.finished_at = "running", None, None, None
    job.created_by = user.id
    # COMMIT (not just flush) before spawning the background task: `_run_stt` opens its OWN
    # session and reads this SttJob by media_id. A bare flush leaves the row uncommitted, so a
    # freshly-created job (the re-transcribe-after-delete case) is invisible to that session —
    # it reads `job is None`, returns doing nothing, and the row is left stuck 'running' with no
    # live task, which the get_transcription orphan-check then force-fails ("Serverneustart …").
    await db.commit()
    task = asyncio.create_task(_run_stt(media_id, media.storage_key))
    _stt_tasks[key] = task
    task.add_done_callback(lambda _t: _stt_tasks.pop(key, None))
    return JSONResponse({"status": "running"}, status_code=202)


@router.get("/media/{media_id}/transcription")
async def get_transcription(
    media_id: uuid.UUID, _user: CurrentUser, db: AsyncSession = Depends(get_db)
) -> dict:
    job = (await db.execute(select(SttJob).where(SttJob.media_id == media_id))).scalar_one_or_none()
    if job is None:
        return {"status": "none", "error": None, "segments": None}
    # a job orphaned by a server restart must not spin forever in the player
    if job.status in ("queued", "running") and str(media_id) not in _stt_tasks:
        job.status, job.error = "failed", "Serverneustart während der Transkription"
        await db.flush()
    return {"status": job.status, "error": job.error, "segments": job.segments}


@router.delete("/media/{media_id}/transcription")
async def delete_transcription(
    media_id: uuid.UUID, _user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> dict:
    """Discard a transcription (drafts are working data — confirmed journal rows stay).
    Resets the recording to 'no job', so Transkribieren can run fresh."""
    job = (await db.execute(select(SttJob).where(SttJob.media_id == media_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Keine Transkription vorhanden")
    await db.delete(job)
    await db.flush()
    return {"ok": True}


class SegmentPatch(BaseModel):
    status: Literal["confirmed", "dismissed"]
    rowId: str | None = None  # noqa: N815 — mirrors the frontend's camelCase field
    text: str | None = None   # corrected utterance text (post-confirm edits stay in sync)


@router.patch("/media/{media_id}/transcription/segments/{index}")
async def patch_segment(
    media_id: uuid.UUID, index: int, body: SegmentPatch, _user: CurrentEditor,
    db: AsyncSession = Depends(get_db),
) -> dict:
    job = (await db.execute(select(SttJob).where(SttJob.media_id == media_id))).scalar_one_or_none()
    if job is None or job.status != "done" or not job.segments:
        raise HTTPException(status_code=404, detail="Keine Transkription vorhanden")
    if not (0 <= index < len(job.segments)):
        raise HTTPException(status_code=404, detail="Segment nicht gefunden")
    # reassign (not mutate) so SQLAlchemy's JSONB change detection persists it
    segments = [dict(s) for s in job.segments]
    segments[index]["status"] = body.status
    if body.rowId:
        segments[index]["rowId"] = body.rowId
    if body.text is not None and body.text.strip():
        segments[index]["text"] = body.text.strip()
    job.segments = segments
    await db.flush()
    return {"ok": True}
