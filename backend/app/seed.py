"""Seed predefined users from a JSON file (PINs hashed on insert).

Idempotent at the user level: existing usernames are skipped (PINs are never
overwritten — reset is admin/CLI only, out-of-band). Run via `python -m app.seed`
or automatically on startup when SEED_DATABASE=true.
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


async def seed_users() -> int:
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", settings.seed_users_file))
    if not os.path.isfile(path):
        # Also allow a path relative to CWD.
        path = settings.seed_users_file
    if not os.path.isfile(path):
        logger.warning("Seed users file not found (%s) — skipping.", settings.seed_users_file)
        return 0

    with open(path, encoding="utf-8") as fh:
        entries = json.load(fh)

    created = 0
    async with async_session_maker() as db:
        for e in entries:
            existing = (
                await db.execute(select(User).where(User.username == e["username"]))
            ).scalar_one_or_none()
            if existing is not None:
                continue
            db.add(
                User(
                    username=e["username"],
                    display_name=e.get("display_name", e["username"]),
                    role=e.get("role", "viewer"),
                    color=e.get("color"),
                    pin_hash=hash_pin(str(e["pin"])),
                )
            )
            created += 1
        await db.commit()
    if created:
        logger.info("Seeded %d user(s).", created)
    return created


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(seed_users())
