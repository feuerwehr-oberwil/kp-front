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
    files = [p for p in pathlib.Path(storage_mod._ROOT).rglob("*") if p.is_file()]
    assert len(files) == 1


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
    for blob in [p for p in pathlib.Path(storage_mod._ROOT).rglob("*") if p.is_file()]:
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
