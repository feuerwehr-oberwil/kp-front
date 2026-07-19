"""Reset the user roster to exactly the seed file (admin/CLI, out-of-band).

Unlike `seed.py` (which only inserts missing users and never touches existing PINs),
this RESETS: it upserts every user in the seed file (updating display_name/role/color
AND pin_hash) and deactivates any existing user whose username is not in the file. It
deactivates rather than deletes, so FK references (incidents.created_by, notes, events,
media, …) stay intact and the roster (active-only) shows just the seeded users.

Run with the TARGET environment's SECRET_KEY (PIN pepper) and DATABASE_URL, e.g.:
    SECRET_KEY=<prod> DATABASE_URL=<prod-public> uv run python -m app.reset_roster
"""

import asyncio
import json
import logging
import os

from sqlalchemy import select

from .auth.security import hash_pin
from .config import settings
from .database import async_session_maker
from .models import User

logger = logging.getLogger(__name__)


async def reset_roster() -> None:
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", settings.seed_users_file))
    if not os.path.isfile(path):
        path = settings.seed_users_file
    with open(path, encoding="utf-8") as fh:
        entries = json.load(fh)

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
                        pin_hash=hash_pin(str(e["pin"])),
                        is_active=True,
                    )
                )
                logger.info("created user %s", e["username"])
            else:
                u.display_name = e.get("display_name", u.display_name)
                u.role = e.get("role", u.role)
                u.color = e.get("color")
                u.pin_hash = hash_pin(str(e["pin"]))
                u.is_active = True
                logger.info("updated user %s (PIN reset)", e["username"])

        for username, u in existing.items():
            if username not in wanted and u.is_active:
                u.is_active = False
                logger.info("deactivated user %s", username)

        await db.commit()
    logger.info("Roster reset complete (%d active user(s)).", len(wanted))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(reset_roster())
