"""Seeding must not create a publicly-known editor login in production.

The shipped seed file is `fu` / PIN 000000 / role editor, and SEED_DATABASE defaults to
true. A station following the documented `docker compose --profile tls up -d` therefore came
up with an internet-facing editor account whose PIN is printed in the README, SETUP.md and
DEPLOYMENT.md. kp-rueck already refuses to seed shared accounts in production without an
explicit password; this is the same rule for kp-front.

Development is deliberately untouched — the frictionless `just dev` login is the point there.

The list of publicly-known PINs is shared with the admin API (`auth.security.TRIVIAL_PINS`),
which refuses the same six on every create/reset — see test_user_admin.py. Boot-time and
API-time are the two ends of one rule, not two lists.
"""

import pytest

from app import seed as seed_module
from app.auth.security import TRIVIAL_PINS
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


@pytest.mark.parametrize("weak", sorted(TRIVIAL_PINS - {"000000"}))
def test_production_rejects_other_well_known_pins(production, monkeypatch, weak):
    monkeypatch.setattr(settings, "seed_pin", weak)
    with pytest.raises(ValueError, match="weak PINs"):
        seed_module.resolve_seed_pin()


def test_the_seeder_reads_the_shared_list(monkeypatch):
    """One rule, one list. If seed.py ever grew its own copy again, this fails.

    The rule already lived in three places once — seed.py, the admin PIN sheet's mirrored
    client-side copy, and nowhere on the write path that actually mattered.

    ⚠️ The identity check below is what actually detects a second copy, and the monkeypatch that
    follows it does NOT: a drifted local `TRIVIAL_PINS = {...}` in seed.py is patched exactly as
    the imported name is, so `resolve_seed_pin` would follow the swap and this test would pass
    over the very duplication it is named for. `is` is the whole assertion; the swap only shows
    that the name is the one being read.
    """
    assert seed_module.TRIVIAL_PINS is TRIVIAL_PINS, "seed.py carries its own copy of the list"
    monkeypatch.setattr("app.seed.TRIVIAL_PINS", frozenset({"482913"}))
    monkeypatch.setattr(settings, "seed_pin", "482913")
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
    assert any(str(e.get("pin")) in TRIVIAL_PINS and e.get("role") == "editor" for e in entries), (
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


def test_init_env_generates_a_seed_pin_the_backend_will_accept():
    """⚠️ The other half of the promise above, and the half that was missing.

    `resolve_seed_pin` refusing is only useful if a deployment ever HAS a PIN to refuse. The
    generator wrote POSTGRES_PASSWORD, SECRET_KEY and ADMIN_SECRET and left SEED_PIN blank, so
    the documented setup path produced exactly the state this module raises on — and `main.py`
    logged it and carried on, leaving a green stack with no accounts.

    Pinned as a property of the script, not of one run: six digits, substituted into the file,
    and never one of the PINs this module rejects.
    """
    import re
    import shutil
    import subprocess
    import tempfile
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory() as tmp:
        fake = Path(tmp)
        (fake / "scripts").mkdir()
        (fake / ".env.example").write_text((root / ".env.example").read_text(encoding="utf-8"), encoding="utf-8")
        (fake / "scripts" / "init-env.sh").write_text(
            (root / "scripts" / "init-env.sh").read_text(encoding="utf-8"), encoding="utf-8"
        )
        bash = shutil.which("bash")
        assert bash, "bash is needed to exercise the setup script"
        subprocess.run([bash, "scripts/init-env.sh"], cwd=fake, check=True, capture_output=True)  # noqa: S603
        env = (fake / ".env").read_text(encoding="utf-8")

    pin = re.search(r"^SEED_PIN=(.*)$", env, re.MULTILINE)
    assert pin, "init-env.sh left no SEED_PIN line at all"
    value = pin.group(1).strip()
    assert re.fullmatch(r"\d{6}", value), f"SEED_PIN must be six digits, got {value!r}"
    assert value not in TRIVIAL_PINS, "generated a PIN the backend refuses as public"


def test_init_env_excludes_exactly_the_backends_list():
    """The generator carries the blocklist a SECOND time, in bash — so pin the copy.

    The test above only samples one random PIN, so a list that drifted would pass it 999_994
    times out of a million: the generator would keep emitting a PIN the backend refuses and the
    station would meet it as a boot loop. Compared as sets against the shared Python one.
    """
    import re
    from pathlib import Path

    script = (Path(__file__).resolve().parents[2] / "scripts" / "init-env.sh").read_text(encoding="utf-8")
    case = re.search(r"^\s*([\d|]+)\)\s*continue\s*;;", script, re.MULTILINE)
    assert case, "init-env.sh no longer has a `<pin>|<pin>) continue ;;` exclusion arm"
    assert set(case.group(1).split("|")) == set(TRIVIAL_PINS)
