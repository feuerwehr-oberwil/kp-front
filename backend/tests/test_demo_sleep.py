"""The public demo falls asleep when unused: every timer stands still, and only real use moves it.

Railway sleeps a service 5–10 min after its last outbound packet, so the pinned facts are:
an idle demo's jobs return before touching anything, a quiet request (beacon, wake poll,
probes) never counts as use, a station never goes idle, and the wake page's readiness route
exists only on the demo.
"""

import time

import pytest

from app import demo_sleep
from app.config import settings


@pytest.fixture
def demo(monkeypatch):
    """This process is the public demo (a reset schedule is what makes it one)."""
    monkeypatch.setattr(settings, "demo_reset_cron", "0 0,12 * * *")
    monkeypatch.setattr(demo_sleep, "_last_use", time.monotonic())


def _go_idle(monkeypatch) -> None:
    monkeypatch.setattr(demo_sleep, "_last_use", time.monotonic() - demo_sleep.IDLE_AFTER_SECONDS - 1)


async def test_every_job_of_an_idle_demo_returns_before_it_runs(demo, monkeypatch):
    ran: list[str] = []

    async def job() -> None:
        ran.append("tick")

    scheduler = demo_sleep.QuietScheduler()
    gated = scheduler.add_job(job, "interval", seconds=30, id="any").func

    await gated()
    assert ran == ["tick"], "a demo in use runs its jobs"
    _go_idle(monkeypatch)
    await gated()
    assert ran == ["tick"], "an idle demo's job must make no traffic"
    demo_sleep.touch()
    await gated()
    assert ran == ["tick", "tick"], "the next use starts the jobs again"


async def test_a_station_never_goes_idle(monkeypatch):
    monkeypatch.setattr(settings, "demo_reset_cron", "")
    monkeypatch.setattr(settings, "demo_reset_seconds", 0)
    _go_idle(monkeypatch)
    assert not demo_sleep.idle()


async def test_both_schedulers_are_gated(demo, monkeypatch):
    """The leader's jobs and the per-process weather radar — the scheduler builds both quiet."""
    from fastapi import FastAPI

    from app import scheduler

    monkeypatch.setattr(scheduler, "_scheduler", None)
    monkeypatch.setattr(scheduler, "_process_scheduler", None)
    await scheduler.start_scheduler(FastAPI())
    try:
        assert isinstance(scheduler._scheduler, demo_sleep.QuietScheduler)
        assert scheduler._scheduler.get_job("demo_reset") is not None
        if scheduler._process_scheduler is not None:
            assert isinstance(scheduler._process_scheduler, demo_sleep.QuietScheduler)
    finally:
        await scheduler.stop_scheduler()


@pytest.mark.parametrize("path", ["/api/hit", "/api/demo/wake", "/health", "/ready"])
async def test_beacon_wake_poll_and_probes_are_not_use(client, demo, monkeypatch, path):
    _go_idle(monkeypatch)
    await client.request("POST" if path == "/api/hit" else "GET", path)
    assert demo_sleep.idle(), f"{path} alone must not keep the demo awake"


async def test_any_other_request_is_use(client, demo, monkeypatch):
    _go_idle(monkeypatch)
    await client.get("/api/auth/roster")
    assert not demo_sleep.idle()


async def test_wake_route_is_absent_off_the_demo(client, monkeypatch):
    monkeypatch.setattr(settings, "demo_reset_cron", "")
    monkeypatch.setattr(settings, "demo_reset_seconds", 0)
    assert (await client.get("/api/demo/wake")).status_code == 404


async def test_wake_route_answers_the_landing_origin_only(client, engine, demo, monkeypatch):
    import app.api.demo as demo_api

    monkeypatch.setattr(demo_api, "engine", engine)
    r = await client.get("/api/demo/wake", headers={"Origin": "https://kp-front.ch"})
    assert r.status_code == 200
    assert r.json() == {"ready": True}
    assert r.headers["access-control-allow-origin"] == "https://kp-front.ch"
    assert r.headers["cache-control"] == "no-store"

    r = await client.get("/api/demo/wake", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers


async def test_wake_route_is_503_while_the_database_is_down(client, demo, monkeypatch):
    from sqlalchemy.ext.asyncio import create_async_engine

    import app.api.demo as demo_api

    dead = create_async_engine("postgresql+asyncpg://nobody:wrong@127.0.0.1:1/nope")
    monkeypatch.setattr(demo_api, "engine", dead)
    try:
        r = await client.get("/api/demo/wake")
    finally:
        await dead.dispose()
    assert r.status_code == 503
    assert r.json() == {"ready": False}


async def test_boot_resets_the_demo_and_only_the_demo(monkeypatch):
    import app.demo_reset as demo_reset

    calls: list[bool] = []

    async def fake_reset(*, wipe_objects: bool = True) -> None:
        calls.append(wipe_objects)

    monkeypatch.setattr(demo_reset, "reset", fake_reset)
    monkeypatch.setattr(settings, "demo_reset_cron", "")
    monkeypatch.setattr(settings, "demo_reset_seconds", 0)
    await demo_sleep.reset_on_boot()
    assert calls == [], "a station must never wipe itself on boot"

    monkeypatch.setattr(settings, "demo_reset_cron", "0 0,12 * * *")
    await demo_sleep.reset_on_boot()
    assert calls == [False], "the boot reset keeps the Einsatzobjekte, like the timed one"
