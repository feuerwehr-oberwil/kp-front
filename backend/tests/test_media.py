"""Media upload/serve (POST /api/incidents/{id}/media, GET /api/media/{id}).

Photos/audio are the incident's legal artifacts, so this covers the whole guard rail:
- editor uploads a photo → 201 and the same bytes stream back with the content type;
- a viewer can read but not upload (CurrentEditor vs CurrentUser);
- unauthenticated requests are rejected on both routes;
- the content-type allowlist rejects executables/html (415) and a bogus kind is 422;
- unknown incident → 404; DB row whose blob vanished from storage → 404, not a 500;
- the storage-key path-traversal guard refuses keys that escape the root.
"""

import pathlib
import uuid

import pytest

import app.storage as storage_mod
from app.api import media as media_mod

JPEG = b"\xff\xd8\xff\xe0fakejpegbytes"
# minimal ISO-BMFF header: 32-byte ftyp box (size + 'ftyp' + brand) + payload
M4A = b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00M4A mp42isom\x00\x00\x00\x00" + b"audiodata"


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    """Point the storage root at a per-test tmp dir so tests never touch data/storage."""
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _create_incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Test Einsatz"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _photo(name: str = "foto.jpg", content_type: str = "image/jpeg", data: bytes = JPEG):
    return {"file": (name, data, content_type)}


async def test_upload_and_serve_roundtrip(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data={"kind": "photo"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "photo"
    assert body["url"] == f"/api/media/{body['id']}"

    served = await client.get(body["url"])
    assert served.status_code == 200
    assert served.content == JPEG
    assert served.headers["content-type"] == "image/jpeg"


async def test_viewer_can_read_but_not_upload(client, editor, viewer):
    await _login(client, editor)
    inc = await _create_incident(client)
    up = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data={"kind": "photo"})
    assert up.status_code == 201

    await _login(client, viewer)
    denied = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data={"kind": "photo"})
    assert denied.status_code == 403
    served = await client.get(up.json()["url"])
    assert served.status_code == 200


async def test_unauthenticated_is_rejected(client):
    r = await client.post(f"/api/incidents/{uuid.uuid4()}/media", files=_photo(), data={"kind": "photo"})
    assert r.status_code == 401
    r = await client.get(f"/api/media/{uuid.uuid4()}")
    assert r.status_code == 401


async def test_content_type_allowlist(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    # html as photo → 415 (stored blobs must never become a serving vector)
    r = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("x.html", b"<script>", "text/html")},
        data={"kind": "photo"},
    )
    assert r.status_code == 415
    # image type under kind=audio is also rejected — the allowlist is per kind
    r = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data={"kind": "audio"})
    assert r.status_code == 415
    # bogus kind → 422
    r = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data={"kind": "video"})
    assert r.status_code == 422


async def test_m4a_upload_roundtrip(client, editor):
    """Voice Memos export: audio/mp4 (and x-m4a) with a real ftyp signature is accepted."""
    await _login(client, editor)
    inc = await _create_incident(client)
    for ct in ("audio/mp4", "audio/x-m4a"):
        r = await client.post(
            f"/api/incidents/{inc}/media",
            files={"file": ("memo.m4a", M4A, ct)},
            data={"kind": "audio"},
        )
        assert r.status_code == 201, r.text
        served = await client.get(r.json()["url"])
        assert served.status_code == 200
        assert served.content == M4A
        assert served.headers["content-type"] == ct


async def test_m4a_without_isobmff_signature_rejected(client, editor):
    """A file merely labelled m4a (no ftyp box) must not be stored."""
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("fake.m4a", b"not an mp4 container at all", "audio/mp4")},
        data={"kind": "audio"},
    )
    assert r.status_code == 415
    assert not [p for p in pathlib.Path(storage_mod._ROOT).rglob("*") if p.is_file()]


@pytest.mark.parametrize(
    "name,ctype,real",
    [
        ("memo.webm", "audio/webm", b"\x1a\x45\xdf\xa3\x9fB\x86\x81\x01"),
        ("memo.ogg", "audio/ogg", b"OggS\x00\x02" + b"\x00" * 8),
        ("memo.wav", "audio/wav", b"RIFF\x24\x00\x00\x00WAVEfmt "),
        ("memo.mp3", "audio/mpeg", b"ID3\x04\x00\x00\x00\x00\x00\x00"),
        ("memo.mp3", "audio/mpeg", b"\xff\xfb\x90\x64" + b"\x00" * 8),
        ("memo.mp3", "audio/mpeg", b"\x00" * 300 + b"\xff\xfb\x90\x64"),  # padding before the first frame
        ("memo.wav", "audio/wav", b"RF64\xff\xff\xff\xffWAVEds64"),
        ("memo.wav", "audio/wav", b"RIFX\x00\x00\x00\x24WAVEfmt "),
    ],
)
async def test_audio_is_stored_only_when_it_is_that_audio(client, editor, name, ctype, real):
    """Hunt 24.11.2026, access-control F9: WebM, Ogg, WAV and MP3 were stored on the label
    alone – the Verlauf kept a «recording» the player could not open."""
    await _login(client, editor)
    inc = await _create_incident(client)
    fake = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": (name, b"not audio at all, just text", ctype)},
        data={"kind": "audio"},
    )
    assert fake.status_code == 415
    ok = await client.post(f"/api/incidents/{inc}/media", files={"file": (name, real, ctype)}, data={"kind": "audio"})
    assert ok.status_code == 201, ok.text


async def test_octet_stream_named_m4a_rejected(client, editor):
    """The allowlist is by content type — a .m4a filename doesn't rescue octet-stream."""
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("memo.m4a", M4A, "application/octet-stream")},
        data={"kind": "audio"},
    )
    assert r.status_code == 415


async def test_size_limit_enforced_and_partial_cleaned(client, editor, monkeypatch):
    """Over the cap → 413, and neither a partial blob nor a Media row survives."""
    monkeypatch.setattr(media_mod, "MAX_UPLOAD_BYTES", len(M4A) + 4)
    await _login(client, editor)
    inc = await _create_incident(client)

    # exactly at the limit → accepted
    at_limit = M4A + b"\x00" * 4
    r = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("memo.m4a", at_limit, "audio/mp4")},
        data={"kind": "audio"},
    )
    assert r.status_code == 201, r.text

    # one byte over → 413 and only the accepted upload's file remains on disk
    r = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("big.m4a", at_limit + b"\x00", "audio/mp4")},
        data={"kind": "audio"},
    )
    assert r.status_code == 413
    # The persistent backup guard is metadata, not an uploaded/partial media blob.
    files = [p for p in (pathlib.Path(storage_mod._ROOT) / "media").rglob("*") if p.is_file()]
    assert len(files) == 1


async def test_pdf_label_on_a_non_pdf_body_is_refused(client, editor):
    """L6: the content type is client-supplied, and a stored blob is served back under that
    trusted label — so a 'PDF' has to start with %PDF-."""
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("bericht.pdf", b"<html>kein pdf</html>", "application/pdf")},
        data={"kind": "file"},
    )
    assert r.status_code == 415, r.text
    assert "entspricht nicht" in r.json()["detail"]

    ok = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("bericht.pdf", b"%PDF-1.4\nleer", "application/pdf")},
        data={"kind": "file"},
    )
    assert ok.status_code == 201, ok.text


async def test_image_magic_bytes_are_checked_and_a_real_png_passes(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)

    # GIF bytes wearing a JPEG label — refused before anything is stored
    r = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("foto.jpg", b"GIF89a not a jpeg", "image/jpeg")},
        data={"kind": "photo"},
    )
    assert r.status_code == 415, r.text

    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buf, format="PNG")
    ok = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("foto.png", buf.getvalue(), "image/png")},
        data={"kind": "photo"},
    )
    assert ok.status_code == 201, ok.text


async def test_upload_to_unknown_incident_404(client, editor):
    await _login(client, editor)
    r = await client.post(f"/api/incidents/{uuid.uuid4()}/media", files=_photo(), data={"kind": "photo"})
    assert r.status_code == 404


async def test_missing_blob_is_404_not_500(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    up = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data={"kind": "photo"})
    assert up.status_code == 201
    # simulate a restored DB pointing at a lost/older storage volume
    for blob in [p for p in (pathlib.Path(storage_mod._ROOT) / "media").rglob("*") if p.is_file()]:
        blob.unlink()
    r = await client.get(up.json()["url"])
    assert r.status_code == 404


def test_storage_key_traversal_is_rejected():
    with pytest.raises(ValueError):
        storage_mod._full("../outside")
    with pytest.raises(ValueError):
        storage_mod._full("media/../../etc/passwd")
    # a normal nested key stays under the root
    assert storage_mod._full("media/abc/def.jpg").startswith(storage_mod._ROOT)


async def test_media_zip_archives_everything_with_manifest_hashes(client, editor):
    """One ZIP per Einsatz for the digital Ablage: every stored Beilage in original bytes,
    plus a manifest whose SHA-256 lets an archive copy be verified years later."""
    import hashlib
    import io
    import json
    import zipfile

    await _login(client, editor)
    inc = await _create_incident(client)
    up1 = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data={"kind": "photo"})
    up2 = await client.post(
        f"/api/incidents/{inc}/media",
        files={"file": ("memo.m4a", M4A, "audio/mp4")},
        data={"kind": "audio"},
    )
    assert up1.status_code == 201 and up2.status_code == 201

    r = await client.get(f"/api/incidents/{inc}/media.zip")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert "manifest.json" in names
    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["incident"]["title"] == "Test Einsatz"
    assert len(manifest["files"]) == 2
    # every manifest entry names a file in the archive, and its hash matches the bytes
    for entry in manifest["files"]:
        assert entry["name"] in names
        assert hashlib.sha256(zf.read(entry["name"])).hexdigest() == entry["sha256"]
    # the originals are byte-identical — full quality, not a re-encode
    photo_name = next(e["name"] for e in manifest["files"] if e["kind"] == "photo")
    assert zf.read(photo_name) == JPEG


async def test_media_zip_absent_without_media_and_without_session(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    assert (await client.get(f"/api/incidents/{inc}/media.zip")).status_code == 404
    await client.post("/api/auth/logout")
    assert (await client.get(f"/api/incidents/{inc}/media.zip")).status_code == 401


def _real_jpeg(size: tuple[int, int] = (2200, 1650)) -> bytes:
    """A decodable JPEG — the fake header above is enough for storage, not for Pillow."""
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, (200, 60, 40)).save(buf, format="JPEG")
    return buf.getvalue()


# The thumbnail is a crash fix, not an optimisation: the Verlauf paints every picture of an
# Einsatz at ~40 px, and pointing those chips at the full 2200 px upload cost ~14 MB of decoded
# bitmap each — enough for iOS to kill the tab on a phone. So what matters here is that the
# route really returns a SMALL image, that it stays a photos-only route, and that it is
# idempotent (rendered once, served from storage afterwards).
async def test_thumb_is_small_and_rendered_once(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/media", files=_photo(data=_real_jpeg()), data={"kind": "photo"})
    assert r.status_code == 201, r.text
    mid = r.json()["id"]

    full = await client.get(f"/api/media/{mid}")
    thumb = await client.get(f"/api/media/{mid}/thumb")
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/jpeg"
    assert len(thumb.content) < len(full.content)

    import io

    from PIL import Image

    with Image.open(io.BytesIO(thumb.content)) as im:
        assert max(im.size) <= media_mod.THUMB_EDGE

    # second call serves the stored derivative — same bytes, no re-render
    again = await client.get(f"/api/media/{mid}/thumb")
    assert again.content == thumb.content


async def test_thumb_of_a_non_photo_is_404(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(
        f"/api/incidents/{inc}/media", files={"file": ("notiz.txt", b"hallo", "text/plain")}, data={"kind": "file"}
    )
    assert r.status_code == 201, r.text
    assert (await client.get(f"/api/media/{r.json()['id']}/thumb")).status_code == 404


async def test_undecodable_photo_falls_back_to_the_original(client, editor):
    """A row must never lose its picture because Pillow could not open the file."""
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data={"kind": "photo"})
    assert r.status_code == 201, r.text
    got = await client.get(f"/api/media/{r.json()['id']}/thumb")
    assert got.status_code == 200
    assert got.content == JPEG


async def test_thumb_requires_a_session(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/media", files=_photo(data=_real_jpeg()), data={"kind": "photo"})
    mid = r.json()["id"]
    client.cookies.clear()
    assert (await client.get(f"/api/media/{mid}/thumb")).status_code == 401


# --- idempotent upload: a retry after a lost response must not store a second copy -------


async def test_a_retried_upload_returns_the_first_and_stores_nothing_new(client, editor, db_session, tmp_path):
    """A proxy timeout loses the response, not the upload: the client retries with the SAME
    upload id, and gets the file the first request already stored."""
    from sqlalchemy import func, select

    from app.models import Media

    await _login(client, editor)
    inc = await _create_incident(client)
    form = {"kind": "photo", "upload_id": "mq1763200000000-01abc"}
    first = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data=form)
    again = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data=form)
    assert first.status_code == 201, first.text
    assert again.status_code in (200, 201), again.text
    assert again.json() == first.json()
    assert (await db_session.execute(select(func.count()).select_from(Media))).scalar_one() == 1
    assert len([p for p in tmp_path.rglob("*") if p.is_file() and ".kp-backup" not in p.parts]) == 1

    # the id is per Einsatz – and a different capture is a different file
    other = await client.post(f"/api/incidents/{inc}/media", files=_photo(), data={**form, "upload_id": "mq2"})
    assert other.json()["id"] != first.json()["id"]


# --- crash leftovers: an upload killed mid-write leaves only an unpublished temp file -----


def test_stale_upload_temp_files_are_swept_and_fresh_ones_kept(tmp_path):
    import os
    import time

    media = tmp_path / "media" / "inc"
    media.mkdir(parents=True)
    stale, fresh, blob = media / ".upload-dead", media / ".upload-live", media / "photo.jpg"
    for p in (stale, fresh, blob):
        p.write_bytes(b"x")
    old = time.time() - 2 * 3600
    os.utime(stale, (old, old))
    os.utime(blob, (old, old))

    assert storage_mod.sweep_upload_leftovers() == 1
    assert not stale.exists()
    assert fresh.exists(), "an upload still being written by another process stays"
    assert blob.exists()


def test_a_nameless_file_downloads_as_a_datei():
    """ENT.12 (17.11.2026): a non-image Verlauf file is a «Datei» — «Beilage» is the Rapport's
    enclosure — so the id fallback says so; the operator's own name still wins."""
    mid = uuid.uuid4()
    assert media_mod._disposition_name(None, mid, ".pdf") == f"datei-{mid}.pdf"
    assert media_mod._disposition_name("Plan EG.pdf", mid, ".pdf") == "Plan EG.pdf"
