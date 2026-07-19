"""Waveform peaks (GET /api/media/{id}/peaks).

The contract the player relies on: first request kicks a background extraction and returns
202; once cached, the same URL serves the peaks JSON; a failed extraction caches
{"peaks": null} (flat-bar fallback, computed once); photos and missing media are 404.
The PCM reducer itself is covered with synthetic samples, plus a real-ffmpeg roundtrip
when the binary is available locally.
"""

import asyncio
import json
import math
import shutil
import struct
import uuid
import wave

import pytest

import app.audio as audio_mod
import app.storage as storage_mod

M4A = b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00M4A mp42isom\x00\x00\x00\x00" + b"audiodata"


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


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


async def _poll_peaks(client, media_id, tries=100):
    for _ in range(tries):
        r = await client.get(f"/api/media/{media_id}/peaks")
        if r.status_code != 202:
            return r
        await asyncio.sleep(0.02)
    raise AssertionError("peaks never finished")


def test_rebucket_normalises_and_reduces():
    coarse = [0, 16384, 32768] * 2000
    out = audio_mod._rebucket(coarse, 2000)
    assert len(out) == 2000
    assert all(0.0 <= v <= 1.0 for v in out)
    assert max(out) == 1.0
    # short recordings keep their coarse resolution instead of being stretched
    assert audio_mod._rebucket([32768, 0], 2000) == [1.0, 0.0]


def test_max_abs_handles_negative_peaks_and_odd_bytes():
    seg = struct.pack("<3h", 1000, -30000, 2000)
    assert audio_mod._max_abs(seg) == 30000
    assert audio_mod._max_abs(seg + b"\x01") == 30000  # trailing odd byte ignored
    assert audio_mod._max_abs(b"") == 0


async def test_peaks_endpoint_202_then_cached(client, editor, monkeypatch):
    async def fake_extract(_path):
        return [0.5] * 10
    monkeypatch.setattr(audio_mod, "extract_peaks", fake_extract)
    await _login(client, editor)
    media_id = await _upload_audio(client)

    first = await client.get(f"/api/media/{media_id}/peaks")
    assert first.status_code == 202
    done = await _poll_peaks(client, media_id)
    assert done.status_code == 200
    assert done.json() == {"version": 1, "peaks": [0.5] * 10}
    # the cache file rides next to the blob
    again = await client.get(f"/api/media/{media_id}/peaks")
    assert again.status_code == 200


async def test_failed_extraction_caches_null(client, editor, monkeypatch):
    async def fake_extract(_path):
        return None
    monkeypatch.setattr(audio_mod, "extract_peaks", fake_extract)
    await _login(client, editor)
    media_id = await _upload_audio(client)
    await client.get(f"/api/media/{media_id}/peaks")
    done = await _poll_peaks(client, media_id)
    assert done.status_code == 200
    assert done.json()["peaks"] is None


async def test_peaks_for_photo_or_unknown_is_404(client, editor):
    await _login(client, editor)
    r = await client.post("/api/incidents", json={"title": "T"})
    inc = r.json()["id"]
    up = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("f.jpg", b"\xff\xd8\xff\xe0x", "image/jpeg")},
        data={"kind": "photo"},
    )
    assert (await client.get(f"/api/media/{up.json()['id']}/peaks")).status_code == 404
    assert (await client.get(f"/api/media/{uuid.uuid4()}/peaks")).status_code == 404


async def test_peaks_requires_auth(client):
    r = await client.get(f"/api/media/{uuid.uuid4()}/peaks")
    assert r.status_code == 401


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
async def test_extract_peaks_real_ffmpeg(tmp_path):
    """A 2 s 440 Hz sine wav decodes into a non-trivial envelope."""
    path = tmp_path / "tone.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        frames = b"".join(
            struct.pack("<h", int(20000 * math.sin(2 * math.pi * 440 * i / 8000)))
            for i in range(16000)
        )
        w.writeframes(frames)
    peaks = await audio_mod.extract_peaks(str(path))
    assert peaks is not None and len(peaks) > 10
    assert max(peaks) > 0.5


async def test_extract_peaks_missing_binary(monkeypatch, tmp_path):
    async def boom(*_a, **_k):
        raise FileNotFoundError("ffmpeg")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", boom)
    assert await audio_mod.extract_peaks(str(tmp_path / "x.m4a")) is None


def test_exercise_delete_also_removes_peaks(tmp_path, monkeypatch):
    """The peaks cache key derives from the blob key, so the deletion loop's
    `key + '.peaks.json'` matches what compute_and_store_peaks writes."""
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))
    storage_mod.put_bytes("media/i1/a.m4a", b"x")
    storage_mod.put_bytes(audio_mod.peaks_key("media/i1/a.m4a"), json.dumps({"peaks": []}).encode())
    storage_mod.delete("media/i1/a.m4a")
    storage_mod.delete("media/i1/a.m4a" + ".peaks.json")
    assert not storage_mod.exists(audio_mod.peaks_key("media/i1/a.m4a"))
