"""Coverage for two operator CLIs that write production configuration but had almost none:
``admin_visits.py`` (0%) and ``admin_branding.py`` (39%). Both are run by hand against a LIVE
deployment, so what's worth locking down is the same thing for any terminal tool: does each
subcommand do what its help text promises, does a bad server answer turn into a readable
stderr line instead of a traceback, and does a bad argument fail before anything is sent.

WHY THESE ARE DRIVEN IN-PROCESS, NOT AS A SUBPROCESS (unlike ``test_admin_cli_output.py``'s
other ``admin_*`` CLIs): ``admin_visits.main()`` and ``admin_branding``'s ``load`` command
each wrap their DB work in their own ``asyncio.run()``. Calling that from inside an already
running pytest-asyncio test would hand it the fixture engine's pool, whose asyncpg
connections are tied to a DIFFERENT running loop — confirmed while building this file, it
fails with "Future attached to a different loop". Calling the underlying coroutine directly
(``admin_visits._amain(...)``, ``admin_branding._load(...)``) sidesteps the second loop
entirely and, as a side benefit, is what lets coverage attribute these lines at all — a
subprocess's coverage is invisible to `pytest-cov` here (no ``COVERAGE_PROCESS_START``
plumbing in this repo). The two argument-parsing edges of `load` that fail before touching
`asyncio.run()` (missing file, disallowed extension) are driven through the real `main()`
instead, since nothing about them is loop-sensitive.

`push`/`show` never touch a database or `asyncio.run()` at all — they are synchronous
`httpx.Client` calls, so those run through `main()` with the transport swapped for an
`httpx.MockTransport` (the pattern `test_weather.py` uses for the async client). No test in
this file makes a real network call.
"""

import re
import struct
import sys
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import select

from app import admin_branding, admin_visits, storage, visits
from app import database as database_module
from app.config import settings
from app.models import DeploymentConfig, VisitHash, VisitStat


def _main(monkeypatch: pytest.MonkeyPatch, *args: str) -> None:
    """Drive `admin_branding.main()` exactly as `python -m app.admin_branding ...` would."""
    monkeypatch.setattr(sys, "argv", ["admin_branding", *args])
    admin_branding.main()


@pytest.fixture(autouse=True)
def _no_ambient_branding_env(monkeypatch: pytest.MonkeyPatch):
    """`--base`/`--secret` default from KP_BASE_URL/KP_ADMIN_SECRET — clear both so a
    developer's shell (or CI) can't make a "missing" test pass by accident."""
    monkeypatch.delenv("KP_BASE_URL", raising=False)
    monkeypatch.delenv("KP_ADMIN_SECRET", raising=False)


@pytest.fixture
def mock_http(monkeypatch: pytest.MonkeyPatch):
    """Install a MockTransport-backed `httpx.Client` for one test (the sync counterpart of the
    `AsyncClient` pattern in `test_weather.py`). Patches `__init__`, not the class itself — a
    lambda replacing `httpx.Client` outright would recurse, since `_push`/`_show` call
    `httpx.Client(...)` by that same name. No test using this fixture makes a real network call."""

    def _install(handler):
        transport = httpx.MockTransport(handler)
        orig_init = httpx.Client.__init__

        def patched_init(self, *args, **kwargs):
            kwargs["transport"] = transport
            orig_init(self, *args, **kwargs)

        monkeypatch.setattr(httpx.Client, "__init__", patched_init)

    return _install


class _FakeRequest:
    """Just enough of a starlette Request for `visits.record` to hash a visitor."""

    def __init__(self, ip: str = "198.51.100.7", ua: str = "Mozilla/5.0 (Test)") -> None:
        self.headers = {"user-agent": ua}
        self.client = type("C", (), {"host": ip})()


@pytest.fixture
def visits_db(session_factory, monkeypatch: pytest.MonkeyPatch):
    """Point `admin_visits` itself at this test's DB — its `_amain` uses the module-level
    `async_session_maker` binding directly, not a request-scoped session."""
    monkeypatch.setattr(admin_visits, "async_session_maker", session_factory)
    return session_factory


@pytest.fixture
def seed_visits(visits_db, monkeypatch: pytest.MonkeyPatch):
    """`visits_db` plus VISIT_STATS on and the recorder pointed at the same DB, for tests that
    need to write rows before reading them back through the CLI."""
    monkeypatch.setattr(visits, "_session_factory", visits_db)
    monkeypatch.setattr(settings, "visit_stats", True)
    return visits_db


@pytest.fixture
def branding_db(session_factory, monkeypatch: pytest.MonkeyPatch):
    """Point `admin_branding load`'s DB write at this test's DB. `_load` re-imports
    `async_session_maker` FROM `app.database` on every call (a local import, not a
    module-level binding), so the module attribute has to be patched there — patching
    `admin_branding`'s own namespace would patch a name it never binds."""
    monkeypatch.setattr(database_module, "async_session_maker", session_factory)
    return session_factory


def _fake_png(width: int, height: int) -> bytes:
    """Only the bytes `_check_icon`/`_png_size` actually read — the signature plus IHDR's
    declared size (see `app/api/branding.py::_png_size`). A real encoder isn't needed to
    exercise the square/scale checks, which never look past the header."""
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", width, height) + b"\x00" * 8


# === admin_visits =========================================================================


@pytest.mark.asyncio
async def test_no_data_in_the_window_says_so(visits_db, monkeypatch: pytest.MonkeyPatch, capsys):
    monkeypatch.setattr(settings, "visit_stats", True)

    code = await admin_visits._amain(["--days", "5"])

    assert code == 0
    assert capsys.readouterr().out.strip() == "No visits recorded in the last 5 day(s)."


@pytest.mark.asyncio
async def test_full_report_lists_the_day_then_the_totals(seed_visits, capsys):
    await visits.record("page", "de", _FakeRequest())
    await visits.record("feature", "atemschutz", _FakeRequest(ip="203.0.113.9"))

    code = await admin_visits._amain([])

    assert code == 0
    out = capsys.readouterr().out
    assert visits.today().isoformat() in out  # the per-day block's own heading
    assert "Landing page" in out
    assert "Features" in out
    assert "Total, last 30 day(s)" in out
    # each key's row appears twice — once under its day, once again in the totals block
    assert len(re.findall(r"\bde\s+1\s+1\b", out)) == 2
    assert len(re.findall(r"\batemschutz\s+1\s+1\b", out)) == 2


@pytest.mark.asyncio
async def test_totals_only_skips_the_per_day_blocks(seed_visits, capsys):
    await visits.record("page", "fr", _FakeRequest())

    code = await admin_visits._amain(["--totals"])

    assert code == 0
    out = capsys.readouterr().out
    assert visits.today().isoformat() not in out  # no per-day heading at all
    assert "Total, last 30 day(s)" in out
    assert len(re.findall(r"\bfr\s+1\s+1\b", out)) == 1


@pytest.mark.asyncio
async def test_the_days_window_excludes_older_rows(seed_visits, capsys):
    yesterday = visits.today() - timedelta(days=1)
    await visits.record("page", "it", _FakeRequest(), day=yesterday)
    await visits.record("page", "it", _FakeRequest(ip="203.0.113.9"))  # today

    code = await admin_visits._amain(["--days", "1", "--totals"])

    assert code == 0
    out = capsys.readouterr().out
    # only today's hit falls inside a 1-day window — the total is 1 hit, not 2
    assert len(re.findall(r"\bit\s+1\s+1\b", out)) == 1


@pytest.mark.asyncio
async def test_flag_off_says_so_on_stderr(visits_db, monkeypatch: pytest.MonkeyPatch, capsys):
    monkeypatch.setattr(settings, "visit_stats", False)

    code = await admin_visits._amain([])

    assert code == 0
    captured = capsys.readouterr()
    assert "VISIT_STATS is off on this deployment" in captured.err
    assert captured.out.strip() == "No visits recorded in the last 30 day(s)."


@pytest.mark.asyncio
async def test_prune_reports_the_deleted_count_and_leaves_the_counters(seed_visits, db_session, capsys):
    old = visits.today() - timedelta(days=visits.RETAIN_DAYS + 1)
    await visits.record("page", "de", _FakeRequest(), day=old)

    code = await admin_visits._amain(["--prune"])

    assert code == 0
    out = capsys.readouterr().out.strip()
    assert out == f"OK: 1 dedup row(s) older than {visits.RETAIN_DAYS} days deleted (counters untouched)."

    hashes = (await db_session.execute(select(VisitHash))).scalars().all()
    stats = (await db_session.execute(select(VisitStat))).scalars().all()
    assert hashes == []  # the dedup scratch row is gone
    assert [(s.hits, s.uniques) for s in stats] == [(1, 1)]  # the counted number survives


@pytest.mark.asyncio
async def test_days_rejects_a_non_integer(capsys):
    with pytest.raises(SystemExit) as exc:
        await admin_visits._amain(["--days", "nope"])

    assert exc.value.code == 2
    assert "invalid int value" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_rejects_an_unknown_flag(capsys):
    with pytest.raises(SystemExit) as exc:
        await admin_visits._amain(["--bogus"])

    assert exc.value.code == 2
    assert "unrecognized arguments" in capsys.readouterr().err


# === admin_branding push (mocked HTTP) ====================================================


def test_push_uploads_and_prints_the_resulting_url(tmp_path, monkeypatch: pytest.MonkeyPatch, mock_http, capsys):
    logo = tmp_path / "logo.png"
    logo.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 16)  # content is never inspected by `push`
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/admin/login":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(201, json={"identity": {"assets": {"logo": "https://cdn.example/branding/x.png"}}})

    mock_http(handler)
    _main(monkeypatch, "push", "logo", str(logo), "--base", "http://fake.example", "--secret", "s3cr3t")

    out = capsys.readouterr().out
    assert out.strip() == "OK: logo ← logo.png → https://cdn.example/branding/x.png"
    assert seen == ["/api/admin/login", "/api/branding/logo"]


def test_push_rejects_an_unsupported_extension_before_any_network_call(
    tmp_path, monkeypatch: pytest.MonkeyPatch, mock_http, capsys
):
    bogus = tmp_path / "logo.txt"
    bogus.write_text("not an image")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("push must reject the extension before touching the network")

    mock_http(handler)
    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "push", "logo", str(bogus), "--base", "http://fake.example", "--secret", "s3cr3t")

    assert exc.value.code == 1
    assert "not an allowed image type" in capsys.readouterr().err


def test_push_reports_a_failed_admin_login(tmp_path, monkeypatch: pytest.MonkeyPatch, mock_http, capsys):
    logo = tmp_path / "logo.svg"
    logo.write_text("<svg/>")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="bad secret")

    mock_http(handler)
    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "push", "logo", str(logo), "--base", "http://fake.example", "--secret", "wrong")

    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "admin login to http://fake.example failed (401)" in err
    assert "bad secret" in err


def test_push_reports_a_failed_upload(tmp_path, monkeypatch: pytest.MonkeyPatch, mock_http, capsys):
    logo = tmp_path / "logo.svg"
    logo.write_text("<svg/>")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/admin/login":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(500, text="disk full")

    mock_http(handler)
    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "push", "logo", str(logo), "--base", "http://fake.example", "--secret", "s3cr3t")

    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "upload of logo.svg to logo failed (500)" in err
    assert "disk full" in err


def test_push_without_a_base_url_fails_before_reading_the_file(monkeypatch: pytest.MonkeyPatch, capsys):
    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "push", "logo", "/does/not/matter.png", "--secret", "s3cr3t")

    assert exc.value.code == 1
    assert "set --base or KP_BASE_URL" in capsys.readouterr().err


def test_push_without_a_secret_fails_before_reading_the_file(monkeypatch: pytest.MonkeyPatch, capsys):
    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "push", "logo", "/does/not/matter.png", "--base", "http://fake.example")

    assert exc.value.code == 1
    assert "set --secret or KP_ADMIN_SECRET" in capsys.readouterr().err


def test_push_reports_a_missing_file(tmp_path, monkeypatch: pytest.MonkeyPatch, capsys):
    missing = tmp_path / "missing.png"

    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "push", "logo", str(missing), "--base", "http://fake.example", "--secret", "s3cr3t")

    assert exc.value.code == 1
    assert f"ERROR: {missing} not found" in capsys.readouterr().err


# === admin_branding show (mocked HTTP) ====================================================


def test_show_prints_every_slot_with_set_ones_filled_in(monkeypatch: pytest.MonkeyPatch, mock_http, capsys):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/config"
        return httpx.Response(200, json={"identity": {"assets": {"logo": "https://cdn.example/logo.svg"}}})

    mock_http(handler)
    _main(monkeypatch, "show", "--base", "http://fake.example")

    out = capsys.readouterr().out
    assert f"{'logo':12} https://cdn.example/logo.svg" in out
    assert f"{'favicon':12} – (not set)" in out  # untouched slots say so, in the same column


def test_show_reports_a_non_200_from_config(monkeypatch: pytest.MonkeyPatch, mock_http, capsys):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="maintenance")

    mock_http(handler)
    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "show", "--base", "http://fake.example")

    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "GET /api/config failed (503)" in err
    assert "maintenance" in err


def test_show_without_a_base_url(monkeypatch: pytest.MonkeyPatch, capsys):
    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "show")

    assert exc.value.code == 1
    assert "set --base or KP_BASE_URL" in capsys.readouterr().err


# === admin_branding load (DB-direct) ======================================================


def test_load_reports_a_missing_file(tmp_path, monkeypatch: pytest.MonkeyPatch, capsys):
    """Argument-parsing edges of `load` fail before `main()` reaches its `asyncio.run()`, so
    (unlike the write path below) driving these through the real `main()` is safe."""
    missing = tmp_path / "missing.png"

    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "load", "logo", str(missing))

    assert exc.value.code == 1
    assert f"ERROR: {missing} not found" in capsys.readouterr().err


def test_load_rejects_an_unsupported_extension(tmp_path, monkeypatch: pytest.MonkeyPatch, capsys):
    bogus = tmp_path / "logo.txt"
    bogus.write_text("nope")

    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "load", "logo", str(bogus))

    assert exc.value.code == 1
    assert "not an allowed image type" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_load_writes_the_blob_and_points_the_config_at_it(tmp_path, branding_db, db_session):
    svg = tmp_path / "reportlogo.svg"
    payload = b"<svg>brand</svg>"
    svg.write_bytes(payload)

    url = await admin_branding._load("reportLogo", svg)

    assert url == "/api/branding/file/branding/reportLogo.svg"
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    assert row.config_json["identity"]["assets"]["reportLogo"] == url
    assert storage.get_bytes("branding/reportLogo.svg") == payload


@pytest.mark.asyncio
async def test_load_rejects_a_non_square_icon(tmp_path, branding_db, capsys):
    icon = tmp_path / "icon.png"
    icon.write_bytes(_fake_png(200, 100))

    with pytest.raises(SystemExit) as exc:
        await admin_branding._load("iconPng192", icon)

    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "quadratisch" in err
    assert "200×100" in err


@pytest.mark.asyncio
async def test_load_rejects_an_undersized_icon(tmp_path, branding_db, capsys):
    icon = tmp_path / "icon.png"
    icon.write_bytes(_fake_png(50, 50))

    with pytest.raises(SystemExit) as exc:
        await admin_branding._load("iconPng192", icon)

    assert exc.value.code == 1
    assert "braucht 192×192" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_load_rejects_non_png_bytes_for_an_icon_slot_despite_the_png_suffix(tmp_path, branding_db, capsys):
    """The `.png` suffix alone satisfies the extension allowlist; `_check_icon` still opens
    the bytes, so a mislabeled file fails with the launcher-facing message, not a 500."""
    icon = tmp_path / "icon.png"
    icon.write_bytes(b"not actually a png")

    with pytest.raises(SystemExit) as exc:
        await admin_branding._load("iconPng192", icon)

    assert exc.value.code == 1
    assert "gültige PNG-Datei" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_load_accepts_a_correctly_sized_icon(tmp_path, branding_db, db_session):
    icon = tmp_path / "icon.png"
    icon.write_bytes(_fake_png(192, 192))

    url = await admin_branding._load("iconPng192", icon)

    assert url == "/api/branding/file/branding/iconPng192.png"
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    assert row.config_json["identity"]["assets"]["iconPng192"] == url


@pytest.mark.asyncio
async def test_reloading_the_same_slot_overwrites_the_blob_in_place(tmp_path, branding_db):
    """The nightly demo reset re-runs `load` for the same slot every night — a stable key
    matters so it overwrites rather than leaving one orphaned blob per night (see
    `admin_branding._stable_key`'s own rationale)."""
    first = tmp_path / "logo1.svg"
    first.write_bytes(b"<svg>v1</svg>")
    second = tmp_path / "logo2.svg"
    second.write_bytes(b"<svg>v2</svg>")

    url1 = await admin_branding._load("logo", first)
    url2 = await admin_branding._load("logo", second)

    assert url1 == url2  # a browser holding the old URL keeps resolving it
    assert storage.get_bytes("branding/logo.svg") == b"<svg>v2</svg>"
