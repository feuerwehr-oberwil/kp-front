"""`python -m app.reset_roster` must not hand out a publicly-known login.

The CLI's job is "make the database match the seed file". The shipped file is `fu` / 000000 /
role editor, so the documented production invocation put the README's PIN back onto whatever
DATABASE_URL named — reaching the exact state the boot gate (seed.resolve_seed_pin) and the admin
API (auth.router._hash_pin_or_400) exist to prevent, through the one path that checked nothing.

Everything here drives `reset_roster()` itself, against a real database, and asserts what ended up
in `users.pin_hash` — not the helper in isolation. That shape is why the API gap stayed invisible:
test_seed_pin.py's refusal tests exercised `resolve_seed_pin` only, so a writer that never called
it looked fine.
"""

import json

import pytest
from sqlalchemy import select

from app import reset_roster as reset_module
from app.auth.security import TRIVIAL_PINS, verify_pin
from app.config import settings
from app.models import User
from tests.conftest import TEST_PIN

SHIPPED = [{"username": "fu", "display_name": "Führungsunterstützung", "role": "editor", "pin": "000000"}]
STRONG = [{"username": "fu", "display_name": "Führungsunterstützung", "role": "editor", "pin": "482913"}]


@pytest.fixture
def seed_file(tmp_path, monkeypatch):
    """Point the CLI at a seed file of the test's choosing (absolute path — the module's
    repo-relative lookup falls through to it unchanged)."""

    def _write(entries: list[dict]) -> None:
        path = tmp_path / "seed_users.json"
        path.write_text(json.dumps(entries), encoding="utf-8")
        monkeypatch.setattr(settings, "seed_users_file", str(path))

    return _write


@pytest.fixture
def run(monkeypatch, session_factory, seed_file):
    """Run the CLI the way an operator does, against the test database."""
    monkeypatch.setattr(reset_module, "async_session_maker", session_factory)

    async def _run(entries: list[dict], *, seed_pin: str = "") -> None:
        seed_file(entries)
        monkeypatch.setattr(settings, "seed_pin", seed_pin)
        await reset_module.reset_roster()

    return _run


async def _user(session_factory, username: str = "fu") -> User | None:
    async with session_factory() as db:
        return (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()


@pytest.mark.asyncio
async def test_shipped_seed_file_is_refused_and_writes_nothing(run, session_factory):
    """The real one: no SEED_PIN + the shipped file must not install 000000 on ANY database."""
    with pytest.raises(ValueError, match="publicly-known PIN 000000"):
        await run(SHIPPED)

    assert await _user(session_factory) is None, "a refused run must not have created anybody"


@pytest.mark.asyncio
async def test_a_refusal_leaves_an_existing_roster_untouched(run, session_factory, editor):
    """Refused mid-way would be worse than not running: the PIN in the DB must survive intact."""
    with pytest.raises(ValueError):
        await run(SHIPPED)

    unchanged = await _user(session_factory, "cmd")
    assert unchanged is not None
    assert verify_pin(TEST_PIN, unchanged.pin_hash)
    assert unchanged.is_active, "not even the deactivation half may run"


@pytest.mark.asyncio
async def test_seed_pin_is_what_actually_lands(run, session_factory):
    """SEED_PIN wins over the file's own PIN — the same override boot-time seeding applies."""
    await run(SHIPPED, seed_pin="482913")

    user = await _user(session_factory)
    assert user is not None
    assert verify_pin("482913", user.pin_hash)
    assert not verify_pin("000000", user.pin_hash)


@pytest.mark.asyncio
async def test_a_real_file_pin_still_resets_the_whole_roster(run, session_factory, editor):
    """The tool still does its job: upsert the file's users, deactivate everyone else."""
    await run(STRONG)

    seeded = await _user(session_factory)
    assert seeded is not None
    assert verify_pin("482913", seeded.pin_hash)
    assert seeded.display_name == "Führungsunterstützung"

    dropped = await _user(session_factory, "cmd")
    assert dropped is not None and not dropped.is_active


@pytest.mark.asyncio
async def test_an_existing_users_pin_is_reset_not_kept(run, session_factory):
    """The difference from seed.py: an existing user's PIN IS overwritten."""
    await run(STRONG)
    await run(STRONG, seed_pin="907214")

    user = await _user(session_factory)
    assert user is not None
    assert verify_pin("907214", user.pin_hash)


@pytest.mark.asyncio
async def test_production_without_seed_pin_refuses(run, monkeypatch, session_factory):
    """Shared with the seeder, message and all — even for a file whose own PIN is fine."""
    monkeypatch.setattr(type(settings), "is_production", property(lambda _self: True))

    with pytest.raises(ValueError, match="SEED_PIN is required in production"):
        await run(STRONG)

    assert await _user(session_factory) is None


@pytest.fixture
def no_seed_pin(monkeypatch):
    """An empty SEED_PIN, so the entry's own PIN is the one under test (a developer's `.env`
    would otherwise override it and quietly make these two assert nothing)."""
    monkeypatch.setattr(settings, "seed_pin", "")


@pytest.mark.parametrize("weak", sorted(TRIVIAL_PINS))
def test_every_well_known_pin_is_refused(no_seed_pin, weak):
    """One list, read here too — not a second copy that can drift."""
    with pytest.raises(ValueError, match="publicly-known PIN"):
        reset_module.resolve_reset_pins([{"username": "fu", "pin": weak}])


def test_the_cli_reads_the_shared_list(no_seed_pin, monkeypatch):
    """Swap the shared set out and the CLI must follow it (see test_seed_pin.py's twin).

    ⚠️ The swap alone cannot see a second copy – monkeypatch would replace a drifted local
    `TRIVIAL_PINS` just as happily as the imported name. `is` is the assertion that does.
    """
    assert reset_module.TRIVIAL_PINS is TRIVIAL_PINS, "reset_roster.py carries its own copy of the list"
    monkeypatch.setattr("app.reset_roster.TRIVIAL_PINS", frozenset({"482913"}))
    with pytest.raises(ValueError, match="publicly-known PIN"):
        reset_module.resolve_reset_pins([{"username": "fu", "pin": "482913"}])
