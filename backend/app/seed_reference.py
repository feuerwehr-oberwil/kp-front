"""Seed GLOBAL reference datasets (national/doctrine assets) from current /public assets.

Idempotent: skips datasets that already exist. Files are copied into object storage with
honest source_notes. Run via `python -m app.seed_reference` or on startup.

Station data (Einsatzobjekte + their plans, hydrants, Leitungskataster, canton WMS, …) is
NOT seeded from the repo — it's loaded out-of-band per deployment with
`python -m app.admin_geodata load` (GeoJSON → reference store, render config →
deployment_config.referenceLayers). See docs/CONFIGURATION.md and the private data repo. A
fresh DB therefore seeds only the global symbols and boots with an empty station.
"""

import asyncio
import logging
import os

from sqlalchemy import select

from . import storage
from .database import async_session_maker
from .models import ReferenceDataset

logger = logging.getLogger(__name__)

_PUBLIC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "public"))


async def seed_reference() -> int:
    if not os.path.isdir(_PUBLIC):
        logger.warning("public/ not found at %s — skipping reference seed", _PUBLIC)
        return 0
    created = 0
    async with async_session_maker() as db:
        async def ensure_dataset(ds_id: str, src_path: str, **fields) -> None:
            nonlocal created
            if (await db.execute(select(ReferenceDataset.id).where(ReferenceDataset.id == ds_id))).scalar_one_or_none():
                return
            if not os.path.isfile(src_path):
                logger.warning("seed asset missing: %s", src_path)
                return
            key = storage.new_key("reference", "-" + ds_id.replace(":", "_"))
            storage.copy_in(src_path, key)
            db.add(
                ReferenceDataset(
                    id=ds_id, storage_key=key, size_bytes=os.path.getsize(src_path),
                    source_type="uploaded", **fields,
                )
            )
            created += 1

        # Global symbols (national FKS tactical signs) — the only repo-seeded dataset.
        # KP-Front-authored artwork (tools/gen_symbols.py); the legacy 'symbols:firegis'
        # dataset in older deployments is simply never fetched anymore.
        await ensure_dataset(
            "symbols:tactical", os.path.join(_PUBLIC, "tactical-symbols.json"),
            kind="symbols", title="Taktische Zeichen (FKS)", content_type="application/json",
            source_note="public/tactical-symbols.json (KP Front, FKS-Konvention)",
        )

        await db.commit()
    if created:
        logger.info("Seeded %d reference item(s).", created)
    return created


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(seed_reference())
