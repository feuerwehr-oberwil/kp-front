"""Seeding must not create a publicly-known editor login in production.

The shipped seed file is `fu` / PIN 000000 / role editor, and SEED_DATABASE defaults to
true. A station following the documented `docker compose --profile tls up -d` therefore came
up with an internet-facing editor account whose PIN is printed in the README, SETUP.md and
DEPLOYMENT.md. kp-rueck already refuses to seed shared accounts in production without an
explicit password; this is the same rule for kp-front.

Development is deliberately untouched — the frictionless `just dev` login is the point there.
"""

import pytest

from app import seed as seed_module
from app.config import settings


@pytest.fixture
def production(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(type(settings), "is_production", property(lambda _self: True))


@pytest.fixture
def development(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(type(settings), "is_production", property(lambda _self: False))


def test_production_without_seed_pin_refuses_to_boot(production, monkeypatch):
    """The whole point: no SEED_PIN, no seeded account, and a message saying why."""
    monkeypatch.setattr(settings, "seed_pin", "")
    with pytest.raises(ValueError, match="SEED_PIN is required in production"):
        seed_module.resolve_seed_pin()


def test_production_rejects_the_shipped_default(production, monkeypatch):
    """Retyping 000000 must not satisfy the check — that is the PIN being removed."""
    monkeypatch.setattr(settings, "seed_pin", "000000")
    with pytest.raises(ValueError, match="weak PINs"):
        seed_module.resolve_seed_pin()


@pytest.mark.parametrize("weak", ["111111", "123456", "654321", "999999", "012345"])
def test_production_rejects_other_well_known_pins(production, monkeypatch, weak):
    monkeypatch.setattr(settings, "seed_pin", weak)
    with pytest.raises(ValueError, match="weak PINs"):
        seed_module.resolve_seed_pin()


@pytest.mark.parametrize("bad", ["12345", "1234567", "abcdef", "12 456", ""])
def test_production_rejects_malformed_pins(production, monkeypatch, bad):
    monkeypatch.setattr(settings, "seed_pin", bad)
    with pytest.raises(ValueError):
        seed_module.resolve_seed_pin()


def test_production_accepts_a_real_pin(production, monkeypatch):
    monkeypatch.setattr(settings, "seed_pin", "482913")
    assert seed_module.resolve_seed_pin() == "482913"


def test_development_still_uses_the_seed_file_pin(development, monkeypatch):
    """`just dev` must keep working with no configuration at all."""
    monkeypatch.setattr(settings, "seed_pin", "")
    assert seed_module.resolve_seed_pin() is None


def test_development_honours_an_explicit_pin(development, monkeypatch):
    """Setting it in dev should still take effect, and still be validated."""
    monkeypatch.setattr(settings, "seed_pin", "482913")
    assert seed_module.resolve_seed_pin() == "482913"

    monkeypatch.setattr(settings, "seed_pin", "0")
    with pytest.raises(ValueError):
        seed_module.resolve_seed_pin()


def test_shipped_seed_file_is_still_the_thing_we_are_protecting_against():
    """If the seed file ever stops carrying a weak PIN, this guard can be revisited.

    Written as a test rather than a comment so the assumption is checked, not remembered.
    """
    import json
    from pathlib import Path

    path = Path(seed_module.__file__).parent / "seed_users.json"
    entries = json.loads(path.read_text(encoding="utf-8"))
    assert any(str(e.get("pin")) in seed_module._TRIVIAL_PINS and e.get("role") == "editor" for e in entries), (
        "seed file no longer ships a weak editor PIN — re-read test_seed_pin.py's premise"
    )


# --- upgrade safety: requiring SEED_PIN must not brick existing deployments ------------
#
# SEED_DATABASE defaults to true, so every existing self-hosted station runs with seeding on
# and its users already created. If seed_users() demanded a PIN unconditionally, their next
# `docker compose pull && up -d` would fail to boot over a PIN that would never be used —
# turning a security fix into a breaking change. Seeding nothing needs no PIN.


@pytest.mark.asyncio
async def test_existing_deployment_boots_without_seed_pin(production, monkeypatch, session_factory):
    """All seed users already present + no SEED_PIN → no error, nothing created."""
    from app.auth.security import hash_pin
    from app.models import User

    # seed.py binds the factory at import time, so patch it there rather than in app.database.
    monkeypatch.setattr(seed_module, "async_session_maker", session_factory)
    monkeypatch.setattr(settings, "seed_pin", "")

    async with session_factory() as session:
        session.add(
            User(username="fu", display_name="Führungsunterstützung", role="editor", pin_hash=hash_pin("482913"))
        )
        await session.commit()

    assert await seed_module.seed_users() == 0


@pytest.mark.asyncio
async def test_fresh_production_database_still_refuses(production, monkeypatch, session_factory):
    """The security property survives: an EMPTY database with no SEED_PIN must not seed."""
    monkeypatch.setattr(seed_module, "async_session_maker", session_factory)
    monkeypatch.setattr(settings, "seed_pin", "")

    with pytest.raises(ValueError, match="SEED_PIN is required in production"):
        await seed_module.seed_users()


@pytest.mark.asyncio
async def test_fresh_production_database_seeds_with_a_pin(production, monkeypatch, session_factory):
    """And with a real PIN it seeds normally — the account just isn't publicly known."""
    monkeypatch.setattr(seed_module, "async_session_maker", session_factory)
    monkeypatch.setattr(settings, "seed_pin", "482913")

    assert await seed_module.seed_users() == 1
