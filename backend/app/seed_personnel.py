"""Seed the synthetic demo crew (Mannschaft) into the ``personnel`` table.

A real station's crew arrives via the Divera roster sync. Local dev has no Divera, so
Anwesenheit, Schichtenplanung and the Atemschutz person-assignment would all face an empty
list. This inserts the same twelve synthetic people the demo deployment shows — the list
lives in ``demo_reset.DEMO_PEOPLE``, imported rather than copied so the two can't drift.

Idempotent and purely additive: people already in the table (matched by display name) are
left untouched and nothing is ever deleted, so running it against a Divera-synced database
only adds the demo names. Unlike ``app.demo_reset`` it seeds NO incident and NO alarm —
the point is a usable roster with a quiet board.

    uv run python -m app.seed_personnel        # runs as the last step of `just demo-load`
"""

import asyncio
import logging

from sqlalchemy import select

from .database import async_session_maker
from .demo_reset import DEMO_PEOPLE
from .models import Personnel

logger = logging.getLogger(__name__)


async def seed_demo_personnel() -> int:
    """Insert any missing demo crew members. Returns how many were created."""
    async with async_session_maker() as db:
        existing = set((await db.execute(select(Personnel.display_name))).scalars())
        created = 0
        for first, last in DEMO_PEOPLE:
            name = f"{first} {last}"
            if name in existing:
                continue
            db.add(Personnel(display_name=name, first_name=first, last_name=last, is_active=True))
            created += 1
        await db.commit()
    return created


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    n = asyncio.run(seed_demo_personnel())
    logger.info("Demo crew: %d added, %d already present.", n, len(DEMO_PEOPLE) - n)
