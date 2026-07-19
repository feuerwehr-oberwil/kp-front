"""Server-side audio processing for uploaded voice memos (waveform peaks; the STT
re-encode lives here too). ffmpeg does the decoding — never Python — and nothing in this
module holds a full PCM buffer in memory: the stream is reduced chunk-by-chunk.

ffmpeg is expected in the image (Dockerfile); a missing binary degrades to `None`, which
callers cache as "no peaks" so the client falls back to a flat seek bar.
"""

import asyncio
import json
import os
import tempfile
from array import array

import httpx

from . import storage
from .config import settings

PEAKS_BUCKETS = 2000
_RATE = 8000            # mono decode rate — plenty for a speech amplitude envelope
_COARSE = _RATE // 20   # coarse reduction unit: one max per 50 ms

PEAKS_SUFFIX = ".peaks.json"


def _max_abs(seg: bytes) -> int:
    a = array("h")
    a.frombytes(seg[: len(seg) - (len(seg) % 2)])
    if not a:
        return 0
    return max(max(a), -min(a))


def _rebucket(coarse: list[int], n: int) -> list[float]:
    """Reduce the coarse per-50ms maxes to n buckets, normalised to 0..1."""
    if len(coarse) <= n:
        return [round(v / 32768, 3) for v in coarse]
    out: list[float] = []
    for i in range(n):
        lo = i * len(coarse) // n
        hi = max(lo + 1, (i + 1) * len(coarse) // n)
        out.append(round(max(coarse[lo:hi]) / 32768, 3))
    return out


async def extract_peaks(src_path: str) -> list[float] | None:
    """Decode to mono 8 kHz s16 PCM via ffmpeg and reduce to PEAKS_BUCKETS max-abs values.
    Returns None when ffmpeg is missing or the file doesn't decode."""
    cmd = ["ffmpeg", "-v", "error", "-i", src_path, "-ac", "1", "-ar", str(_RATE), "-f", "s16le", "-"]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
    except FileNotFoundError:
        return None
    assert proc.stdout is not None
    coarse: list[int] = []
    buf = b""
    seg_bytes = _COARSE * 2
    while True:
        data = await proc.stdout.read(65536)
        if not data:
            break
        buf += data
        while len(buf) >= seg_bytes:
            coarse.append(_max_abs(buf[:seg_bytes]))
            buf = buf[seg_bytes:]
    if buf:
        coarse.append(_max_abs(buf))
    rc = await proc.wait()
    if rc != 0 or not coarse:
        return None
    return _rebucket(coarse, PEAKS_BUCKETS)


def peaks_key(storage_key: str) -> str:
    """Peaks cache rides next to the blob so deletion paths clean both with one prefix."""
    return storage_key + PEAKS_SUFFIX


async def compute_and_store_peaks(storage_key: str) -> None:
    """Extract peaks for a stored blob and cache the result — including a `null` marker on
    failure, so a broken file is computed once, not re-attempted on every request."""
    peaks = await extract_peaks(storage.local_path(storage_key))
    storage.put_bytes(peaks_key(storage_key), json.dumps({"version": 1, "peaks": peaks}).encode())


# ---- Speech-to-text -------------------------------------------------------------------

STT_TIMEOUT_SEC = 900  # a multi-hour memo through a slow engine — generous by design


class SttError(Exception):
    """Transcription failed; the message is operator-facing (stored on the job row)."""


async def reencode_for_stt(src_path: str, dst_path: str) -> None:
    """Shrink the recording to mono 24 kbps Opus so multi-hour memos fit the cloud
    engines' ~25 MB per-file caps (2 h ≈ 21 MB) — speech stays fully intelligible."""
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", src_path,
           "-ac", "1", "-c:a", "libopus", "-b:a", "24k", "-application", "voip", dst_path]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
        )
    except FileNotFoundError:
        raise SttError("ffmpeg fehlt auf dem Server") from None
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise SttError(f"Re-Encoding fehlgeschlagen: {err.decode(errors='replace')[:200]}")


async def transcribe(src_path: str) -> list[dict]:
    """Send the (re-encoded) recording to the configured OpenAI-compatible
    `/v1/audio/transcriptions` endpoint and return utterance drafts
    `[{'start': sec, 'end': sec, 'text': str}]`. Raises SttError on any failure."""
    if not settings.stt_base_url:
        raise SttError("Kein STT-Server konfiguriert")
    with tempfile.TemporaryDirectory() as td:
        ogg = os.path.join(td, "audio.ogg")
        await reencode_for_stt(src_path, ogg)
        url = settings.stt_base_url.rstrip("/") + "/v1/audio/transcriptions"
        headers = {"Authorization": f"Bearer {settings.stt_api_key}"} if settings.stt_api_key else {}
        data = {"model": settings.stt_model, "response_format": "verbose_json"}
        if settings.stt_language:
            data["language"] = settings.stt_language
        try:
            async with httpx.AsyncClient(timeout=STT_TIMEOUT_SEC) as client:
                with open(ogg, "rb") as fh:
                    r = await client.post(url, headers=headers, data=data,
                                          files={"file": ("audio.ogg", fh, "audio/ogg")})
        except httpx.HTTPError as e:
            raise SttError(f"STT-Server nicht erreichbar: {type(e).__name__}") from None
    if r.status_code != 200:
        raise SttError(f"STT-Server: HTTP {r.status_code}")
    try:
        body = r.json()
    except ValueError:
        raise SttError("STT-Server: ungültige Antwort") from None
    segments = [
        {"start": float(s.get("start") or 0), "end": float(s.get("end") or 0),
         "text": (s.get("text") or "").strip()}
        for s in (body.get("segments") or [])
    ]
    segments = [s for s in segments if s["text"]]
    # engines without segment timestamps still yield one draft at the recording start
    if not segments and (body.get("text") or "").strip():
        segments = [{"start": 0.0, "end": 0.0, "text": body["text"].strip()}]
    return segments
