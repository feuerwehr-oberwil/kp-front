"""Reset the DEMO deployment's mutable state.

Wipes all incident data (deleting ``incidents`` cascades to people/notes/media/events/
snapshots/vehicle_samples) and the roster, upserts the two fixed demo accounts with known
PINs, and re-seeds one prepared "incoming alarm" (mimics Divera without a real key) so the
demo always shows the one-tap-take flow. Reference config/geodata/objects are reloaded
separately by the CLIs — see ``scripts/demo-reset.sh``.

    DATABASE_URL=<demo db> uv run python -m app.demo_reset

DEMO ONLY. Refuses to run unless KP_DEMO_RESET=1 is set, so it can never be pointed at a
real station's database by accident.
"""

import asyncio
import logging
import os

from sqlalchemy import delete, select

from .auth.security import hash_pin
from .database import async_session_maker
from .models import DiveraEmergency, Incident, ObjectSite, Personnel, User

logger = logging.getLogger(__name__)

# The fixed demo accounts. Both PINs are shown on the demo login screen (identity.demoNote).
DEMO_USERS = [
    {"username": "fu", "display_name": "Führungsunterstützung", "role": "editor", "color": "#c0392b", "pin": "000000"},
    {"username": "demo-viewer", "display_name": "Betrachter", "role": "viewer", "color": "#2c7a5b", "pin": "000000"},
]

# A prepared incoming alarm at Schloss Musterdorf. The pool GET reads this straight from the
# DB (no Divera key needed), so the demo editor sees it on the landing + alarm banner and can
# one-tap-take it into an incident. received_at defaults to now(), so it always looks fresh.
DEMO_ALARM = {
    "divera_id": 990001,
    "divera_number": "2026-DEMO-001",
    "title": "Zimmerbrand",
    "text": "Gemeldeter Zimmerbrand im Obergeschoss, Rauch sichtbar. Personen möglicherweise im Gebäude.",
    "address": "Schlossgasse 9, 4104 Musterdorf",
    "lat": 47.52382,
    "lng": 7.57037,
}

# Dummy roster so Anwesenheit / Atemschutz person-assignment have people to work with.
DEMO_PEOPLE = [
    ("Hans", "Müller"), ("Anna", "Meier"), ("Peter", "Schmid"), ("Laura", "Keller"),
    ("Marco", "Weber"), ("Sarah", "Huber"), ("Thomas", "Brunner"), ("Nina", "Frei"),
    ("Michael", "Baumann"), ("Céline", "Widmer"), ("Stefan", "Graf"), ("Petra", "Roth"),
]


async def reset() -> None:
    async with async_session_maker() as db:
        # Deleting incidents cascades to all incident-scoped tables (ON DELETE CASCADE).
        await db.execute(delete(Incident))
        # Roster is standalone (no incident FK) — clear manual/demo additions, then re-seed
        # the fixed dummy roster so Anwesenheit / person-assignment always have people.
        await db.execute(delete(Personnel))
        for first, last in DEMO_PEOPLE:
            db.add(Personnel(display_name=f"{first} {last}", first_name=first, last_name=last, is_active=True))
        # Clear objects so the manifest is authoritative ("these two, nothing else"). Deleting
        # an ObjectSite cascades to its plan datasets; the geo: reference layers (object_id NULL)
        # are untouched and get re-pushed by the reset script.
        await db.execute(delete(ObjectSite))
        # Clear any prior/taken alarms, then re-seed the one prepared demo alarm fresh.
        await db.execute(delete(DiveraEmergency))
        db.add(DiveraEmergency(**DEMO_ALARM, is_taken=False, is_archived=False))

        for u in DEMO_USERS:
            user = (
                await db.execute(select(User).where(User.username == u["username"]))
            ).scalar_one_or_none()
            if user is None:
                user = User(username=u["username"])
                db.add(user)
            # Re-assert display/role/PIN/active every time so a demo visitor can't lock anyone out.
            user.display_name = u["display_name"]
            user.role = u["role"]
            user.color = u["color"]
            user.pin_hash = hash_pin(u["pin"])
            user.is_active = True
        await db.commit()
    logger.info(
        "Demo reset: wiped incidents + objects, ensured %d user(s), seeded %d people + 1 alarm.",
        len(DEMO_USERS),
        len(DEMO_PEOPLE),
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if os.getenv("KP_DEMO_RESET") != "1":
        raise SystemExit("Refusing to run: set KP_DEMO_RESET=1 to confirm this is a DEMO database.")
    asyncio.run(reset())
