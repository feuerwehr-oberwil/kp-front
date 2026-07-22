"""Export the running demo incident's map/plan scene back into the seed file.

The demo now persists edits, so the maintainer workflow for repositioning the pre-placed demo items
is: arrange them live in the app (drag symbols, redraw hose lines, move the building), then run this
to bake those positions into ``examples/demo-data/incident.workspace.json``. Commit the result — it
becomes the seed the nightly reset reseeds from.

    DATABASE_URL=<demo Postgres public URL> uv run python -m app.demo_export

Reads the single open incident's ``map_workspace_json`` and keeps only the hand-authored scene keys
(entities, drawings, building, board, layerState, recent). The live collections the reset re-adds
each night (trupps, mittel, attendance, …) are dropped, so they never get frozen into the seed.
Read-only on the database; the only thing it writes is the repo file.
"""

import asyncio
import json
import logging
from pathlib import Path

from sqlalchemy import select

from .database import async_session_maker
from .models import Incident

logger = logging.getLogger(__name__)

# demo_export.py → parents[2] is the repo root (same anchor as demo_reset.SCENE_PATH).
SEED_PATH = Path(__file__).resolve().parents[2] / "examples" / "demo-data" / "incident.workspace.json"

# The hand-authored scene: positions + structure only. Everything else in a live workspace
# (trupps/mittel/attendance and any other runtime collections) is reset-managed and must NOT be
# baked into the seed — build_demo_workspace re-adds those with fresh timestamps each reset.
SCENE_KEYS = ["entities", "drawings", "building", "board", "layerState", "recent"]


async def export() -> None:
    async with async_session_maker() as db:
        inc = (
            await db.execute(
                select(Incident)
                .where(Incident.is_archived.is_(False))
                .order_by(Incident.started_at.desc())
            )
        ).scalars().first()
    if inc is None:
        raise SystemExit("No open incident found — is DATABASE_URL pointing at the demo database?")
    ws = inc.map_workspace_json or {}
    scene = {k: ws[k] for k in SCENE_KEYS if k in ws}
    SEED_PATH.write_text(json.dumps(scene, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    logger.info(
        "Wrote %s (%d entities, %d drawings) from incident '%s'. Review the diff and commit.",
        SEED_PATH, len(scene.get("entities", [])), len(scene.get("drawings", [])), inc.title,
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(export())
