"""Liveness (/health) vs readiness (/ready) probes.

Covers:
- /health stays static-ok (pure liveness, no dependencies).
- /ready reports 200 with database+storage ok on a working stack.
- /ready flips to 503 with the failing component named when storage is not writable
  or the database is unreachable — the whole point: healthchecks key off /ready, so a
  data-layer outage must NOT report healthy.
"""

from sqlalchemy.ext.asyncio import create_async_engine


async def test_health_is_static_ok(client):
    r = await client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "version" in body


async def test_health_names_the_build_not_just_the_release(client, monkeypatch):
    """A from-source build of `main` and a published image of the same tag both answer "0.6.0",
    which is why two install bugs could not be pinned to a build. `curl /health` is the first
    thing anybody does to a misbehaving deployment, so the sha and the build moment live there.
    """
    from app.config import settings

    body = (await client.get("/health")).json()
    assert body["commit"] == "dev", "an un-stamped dev process must say so rather than guess"
    assert body["built_at"] == ""

    # What the image build args produce (Dockerfile GIT_SHA / BUILD_TIME → settings).
    monkeypatch.setattr(settings, "git_sha", "9f86d08188")
    monkeypatch.setattr(settings, "build_time", "2026-08-16T04:12:00Z")
    body = (await client.get("/health")).json()
    assert body["commit"] == "9f86d08188"
    assert body["built_at"] == "2026-08-16T04:12:00Z"
    assert body["version"] == settings.version


async def test_ready_ok(client, engine, monkeypatch):
    import app.main as main_mod

    monkeypatch.setattr(main_mod, "engine", engine)
    r = await client.get("/ready")
    assert r.status_code == 200
    body = r.json()
    assert body == {"status": "ok", "version": body["version"], "database": "ok", "storage": "ok"}


async def test_ready_503_when_storage_not_writable(client, engine, monkeypatch):
    import app.main as main_mod
    import app.storage as storage_mod

    monkeypatch.setattr(main_mod, "engine", engine)

    def boom() -> None:
        raise OSError("volume gone")

    monkeypatch.setattr(storage_mod, "probe_writable", boom)
    r = await client.get("/ready")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "error"
    assert body["storage"] == "error"
    assert body["database"] == "ok"


async def test_ready_503_when_database_unreachable(client, monkeypatch):
    import app.main as main_mod

    dead = create_async_engine("postgresql+asyncpg://nobody:wrong@127.0.0.1:1/nope")
    monkeypatch.setattr(main_mod, "engine", dead)
    try:
        r = await client.get("/ready")
    finally:
        await dead.dispose()
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "error"
    assert body["database"] == "error"
    assert body["storage"] == "ok"
