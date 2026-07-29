"""Seed predefined users from a JSON file (PINs hashed on insert).

Idempotent at the user level: existing usernames are skipped (PINs are never
overwritten — reset is admin/CLI only, out-of-band). Run via `python -m app.seed`
or automatically on startup when SEED_DATABASE=true.

In PRODUCTION the PIN never comes from the file. The shipped seed file is `fu` / 000000 /
role editor and SEED_DATABASE defaults to true, so a station that ran the documented
`docker compose --profile tls up -d` used to come up with an internet-facing editor account
whose PIN is printed in the README. Now SEED_PIN is mandatory there and boot fails loudly
if it is missing — the same rule kp-rueck applies to ADMIN_SEED_PASSWORD.
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

# PINs that are not secrets, whatever the environment. Rejecting these stops SEED_PIN from
# becoming a box-ticking exercise satisfied by retyping the value we are trying to remove.
_TRIVIAL_PINS = {"000000", "111111", "123456", "654321", "999999", "012345"}


def resolve_seed_pin() -> str | None:
    """The PIN to seed accounts with, or ``None`` to use each entry's own.

    Raises in production when SEED_PIN is missing or weak, so the failure is a refused boot
    with an explanation rather than a working login nobody chose.
    """
    pin = settings.seed_pin.strip()

    if not pin:
        if settings.is_production:
            raise ValueError(
                "SEED_PIN is required in production. The bundled seed file's PIN is public "
                "(it is in the README), so seeding without an explicit PIN would create an "
                "editor account anyone can log into. Set SEED_PIN to a "
                f"{settings.pin_length}-digit PIN in your .env, or set SEED_DATABASE=false "
                "and create accounts through the admin UI."
            )
        return None  # development: the seed file's own PIN is fine

    if len(pin) != settings.pin_length or not pin.isdigit():
        raise ValueError(f"SEED_PIN must be exactly {settings.pin_length} digits.")
    if pin in _TRIVIAL_PINS:
        raise ValueError("SEED_PIN is one of the well-known weak PINs — choose another.")
    return pin


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
        missing = []
        for e in entries:
            existing = (await db.execute(select(User).where(User.username == e["username"]))).scalar_one_or_none()
            if existing is None:
                missing.append(e)

        if not missing:
            return 0

        # Resolved only once we know an account would actually be created, and BEFORE creating
        # any of them. Requiring it unconditionally would have been a breaking change: every
        # existing deployment runs with SEED_DATABASE=true (the default) and already has its
        # users, so the next `docker compose pull && up -d` would have failed to boot over a
        # PIN that was never going to be used. Seeding nothing needs no PIN.
        seed_pin = resolve_seed_pin()

        for e in missing:
            db.add(
                User(
                    username=e["username"],
                    display_name=e.get("display_name", e["username"]),
                    role=e.get("role", "viewer"),
                    color=e.get("color"),
                    pin_hash=hash_pin(seed_pin or str(e["pin"])),
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
