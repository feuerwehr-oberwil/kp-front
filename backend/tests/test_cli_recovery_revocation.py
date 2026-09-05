"""SEC-05 round-2: the CLI recovery paths must revoke sessions too.

`revoke_sessions` closed SEC-05 for the admin API (see test_session_revocation.py), but the two
out-of-band CLI paths that ALSO rotate a PIN / reactivate an account never called it:

  · ``app.reset_roster`` — the DOCUMENTED compromise-recovery path, run from a maintainer's laptop
    against a production URL. Rotating a compromised account's PIN here used to leave the
    intruder's old access AND refresh cookies fully valid — SEC-05 unfixed on exactly the path an
    operator reaches for after a compromise.
  · ``app.demo_reset`` — re-asserts the two demo accounts' PINs on every reset.

Both now bump the auth generation through the same ``revoke_sessions`` the admin API uses. These
run the real CLI functions against the test database (via a patched ``async_session_maker``) and
prove the generation advances — the mechanism itself is covered in test_session_revocation.py.
"""

import json

import pytest
from sqlalchemy import select

from app.auth.security import create_access_token, hash_pin
from app.models import User

pytestmark = pytest.mark.asyncio

TEST_PIN = "135790"
NEW_PIN = "246803"


async def _make_login_user(session_factory, *, username: str, role: str = "editor") -> User:
    async with session_factory() as s:
        u = User(
            username=username,
            display_name=username.title(),
            role=role,
            pin_hash=hash_pin(TEST_PIN),
            is_active=True,
        )
        s.add(u)
        await s.commit()
        await s.refresh(u)
        return u


async def test_reset_roster_revokes_sessions_on_the_documented_recovery_path(
    client, session_factory, monkeypatch, tmp_path
):
    from app import reset_roster as rr
    from app.auth.router import _claims

    user = await _make_login_user(session_factory, username="cmd")
    assert user.auth_generation == 0
    old_token = create_access_token(_claims(user))  # a session the intruder already holds

    seed = tmp_path / "seed.json"
    seed.write_text(
        json.dumps([{"username": "cmd", "display_name": "Cmd", "role": "editor", "pin": NEW_PIN}]),
        encoding="utf-8",
    )
    monkeypatch.setattr(rr.settings, "seed_users_file", str(seed))
    monkeypatch.setattr(rr, "async_session_maker", session_factory)

    await rr.reset_roster()

    async with session_factory() as s:
        fresh = (await s.execute(select(User).where(User.id == user.id))).scalar_one()
    assert fresh.auth_generation == 1, "reset_roster rotated the PIN but left old sessions valid (SEC-05)"

    # …and the old cookie is actually dead end-to-end.
    client.cookies.set("access_token", old_token)
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_demo_reset_revokes_the_demo_accounts_sessions(session_factory, monkeypatch):
    from app import demo_reset as dr

    # A demo account that already exists (as after a first reset) and holds a session.
    existing = await _make_login_user(session_factory, username="fu", role="editor")
    assert existing.auth_generation == 0

    monkeypatch.setenv("KP_DEMO_RESET", "1")
    monkeypatch.setattr(dr, "async_session_maker", session_factory)

    # wipe_objects=False so the reset needs no reference objects — it still upserts the demo
    # accounts, which is the path under test.
    await dr.reset(wipe_objects=False)

    async with session_factory() as s:
        fresh = (await s.execute(select(User).where(User.username == "fu"))).scalar_one()
    assert fresh.auth_generation == 1, "demo_reset re-asserted the PIN but left old sessions valid (SEC-05)"
