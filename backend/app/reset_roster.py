"""Reset the user roster to exactly the seed file (admin/CLI, out-of-band).

Unlike `seed.py` (which only inserts missing users and never touches existing PINs),
this RESETS: it upserts every user in the seed file (updating display_name/role/color
AND pin_hash) and deactivates any existing user whose username is not in the file. It
deactivates rather than deletes, so FK references (incidents.created_by, notes, events,
media, …) stay intact and the roster (active-only) shows just the seeded users.

The PIN comes from SEED_PIN, resolved by `seed.resolve_seed_pin` — the same function boot-time
seeding uses, so there is ONE well-known-PIN rule and not a second policy here. The file's own
`pin` is only the fallback, and a publicly-known PIN (`auth.security.TRIVIAL_PINS`) is refused
whatever the environment: the shipped seed file says 000000, so the documented invocation below
used to put the README's login back onto whichever database DATABASE_URL named — through the one
path that checked nothing.

⚠️ That last refusal is deliberately NOT conditional on `is_production()`, unlike the seeder's.
This CLI takes its target as an *argument*: it is documented to run from a maintainer's laptop
against a production URL, where the ambient flag describes the shell, not the database. Cost of
that choice: resetting a dev roster to the shipped 000000 is no longer possible — pass a real
SEED_PIN (see the error message), or use a seed file with a real PIN.

Nothing is written before every PIN is settled, so a refusal leaves the roster exactly as it was.

Run with the TARGET environment's SECRET_KEY (PIN pepper) and DATABASE_URL, e.g.:
    SEED_PIN=<pin> SECRET_KEY=<prod> DATABASE_URL=<prod-public> uv run python -m app.reset_roster
"""

import asyncio
import json
import logging
import os

from sqlalchemy import select

from .auth.router import revoke_sessions
from .auth.security import TRIVIAL_PINS, hash_pin
from .config import settings
from .database import async_session_maker
from .models import User
from .seed import resolve_seed_pin

logger = logging.getLogger(__name__)


def resolve_reset_pins(entries: list[dict]) -> dict[str, str]:
    """username → the PIN this run will write, settled for the WHOLE file up front.

    Raises `ValueError` (SEED_PIN missing/weak in production, or a publicly-known PIN in the
    seed file) before the caller has opened a session, so a refused run changes nothing.
    """
    seed_pin = resolve_seed_pin()  # SEED_PIN wins over every entry's own pin, as at boot
    pins: dict[str, str] = {}
    for e in entries:
        pin = seed_pin or str(e["pin"])
        if pin in TRIVIAL_PINS:
            raise ValueError(
                f"Seed file entry '{e['username']}' carries the publicly-known PIN {pin} — it is "
                "printed in the README, so resetting to it would hand out a login anyone can use. "
                f"Set SEED_PIN to a {settings.pin_length}-digit PIN (it replaces every entry's "
                "PIN), or put a real PIN in the seed file."
            )
        pins[e["username"]] = pin
    return pins


async def reset_roster() -> None:
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", settings.seed_users_file))
    if not os.path.isfile(path):
        path = settings.seed_users_file
    with open(path, encoding="utf-8") as fh:
        entries = json.load(fh)

    pins = resolve_reset_pins(entries)
    wanted = {e["username"] for e in entries}
    async with async_session_maker() as db:
        existing = {u.username: u for u in (await db.execute(select(User))).scalars()}

        for e in entries:
            u = existing.get(e["username"])
            if u is None:
                db.add(
                    User(
                        username=e["username"],
                        display_name=e.get("display_name", e["username"]),
                        role=e.get("role", "viewer"),
                        color=e.get("color"),
                        pin_hash=hash_pin(pins[e["username"]]),
                        is_active=True,
                    )
                )
                logger.info("created user %s", e["username"])
            else:
                u.display_name = e.get("display_name", u.display_name)
                u.role = e.get("role", u.role)
                u.color = e.get("color")
                u.pin_hash = hash_pin(pins[e["username"]])
                u.is_active = True
                # The PIN just changed — end the sessions the old one opened, exactly as the
                # admin API does (SEC-05). This is the DOCUMENTED compromise-recovery path (run
                # from a laptop against a prod URL), so leaving old access/refresh cookies alive
                # here would defeat the reset on the one path an operator reaches for.
                await revoke_sessions(db, u)
                logger.info("updated user %s (PIN reset)", e["username"])

        for username, u in existing.items():
            if username not in wanted and u.is_active:
                u.is_active = False
                # Deactivation is the other «throw them out» gesture; drop live sessions too, or
                # a later reactivation would revive them (SEC-05).
                await revoke_sessions(db, u)
                logger.info("deactivated user %s", username)

        await db.commit()
    logger.info("Roster reset complete (%d active user(s)).", len(wanted))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(reset_roster())
    except ValueError as exc:
        # A refused PIN (resolve_reset_pins) is an operator's decision to make, not a crash —
        # one line saying what to set, the way demo_reset renders its own guard.
        raise SystemExit(str(exc)) from None
