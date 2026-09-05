"""Storage and public branding must not follow a path outside their own namespace."""

import pytest

from app import storage


@pytest.fixture
def storage_root(tmp_path, monkeypatch):
    root = tmp_path / "blobs"
    root.mkdir()
    monkeypatch.setattr(storage, "_ROOT", str(root))
    return root


@pytest.mark.parametrize(
    "key", ["", ".", "..", "../secret", "media/../../secret", "/etc/passwd", "media\\secret", "media/\x00"]
)
def test_rejects_invalid_keys(storage_root, key):
    with pytest.raises(ValueError, match="Unsafe storage key"):
        storage.local_path(key)


@pytest.mark.parametrize("link_kind", ["file", "directory"])
async def test_every_blob_operation_rejects_outside_symlinks(storage_root, tmp_path, link_kind):
    # The sibling shares the root's prefix, so a boundary-less startswith also fails.
    outside = tmp_path / "blobs-private"
    outside.mkdir()
    secret = outside / "secret"
    secret.write_bytes(b"private")
    if link_kind == "file":
        (storage_root / "link").symlink_to(secret)
        key = "link"
    else:
        (storage_root / "link").symlink_to(outside, target_is_directory=True)
        key = "link/secret"

    for operation in (storage.get_bytes, storage.exists, storage.delete, storage.local_path, storage.size):
        with pytest.raises(ValueError, match="Unsafe storage key"):
            operation(key)
    with pytest.raises(ValueError, match="Unsafe storage key"):
        storage.put_bytes(key, b"overwrite")

    async def chunks():
        yield b"overwrite"

    with pytest.raises(ValueError, match="Unsafe storage key"):
        await storage.put_astream(key, chunks())
    assert secret.read_bytes() == b"private"


async def test_nested_blobs_and_symlinked_storage_mount_work(storage_root, tmp_path, monkeypatch):
    mount = tmp_path / "mounted"
    mount.symlink_to(storage_root, target_is_directory=True)
    monkeypatch.setattr(storage, "_ROOT", str(mount))
    storage.put_bytes("media/incident/photo.jpg", b"photo")
    assert storage.get_bytes("media/incident/photo.jpg") == b"photo"

    async def chunks():
        yield b"audio"

    assert await storage.put_astream("media/incident/memo.m4a", chunks()) == 5
    assert storage.size("media/incident/memo.m4a") == 5
    storage.delete("media/incident/photo.jpg")
    assert not storage.exists("media/incident/photo.jpg")


@pytest.mark.parametrize("destination", ["outside", "private_blob", "private_directory"])
async def test_public_branding_refuses_symlinks_to_private_files(client, storage_root, tmp_path, destination):
    if destination == "private_directory":
        private = storage_root / "media"
        private.mkdir()
        (private / "logo.png").write_bytes(b"private")
        (storage_root / "branding").symlink_to(private, target_is_directory=True)
    else:
        secret = (tmp_path if destination == "outside" else storage_root) / "secret.png"
        secret.write_bytes(b"private")
        branding = storage_root / "branding"
        branding.mkdir()
        (branding / "logo.png").symlink_to(secret)

    response = await client.get("/api/branding/file/branding/logo.png")
    assert response.status_code == 404
    assert b"private" not in response.content


async def test_public_branding_serves_regular_blob(client, storage_root):
    storage.put_bytes("branding/logo.png", b"logo")
    response = await client.get("/api/branding/file/branding/logo.png")
    assert response.status_code == 200
    assert response.content == b"logo"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]
