"""Seed the singleton deployment-config row (id=1) with an empty document.

Idempotent: inserts the row only if it is absent; never overwrites an existing config.
An empty `{}` is a valid config (the app runs as a generic empty station). Run via
`python -m app.seed_config` or automatically on startup when SEED_DATABASE=true.
"""

import asyncio
import logging

from sqlalchemy import select

from .database import async_session_maker
from .models import DeploymentConfig

logger = logging.getLogger(__name__)


async def seed_deployment_config() -> int:
    async with async_session_maker() as db:
        existing = (
            await db.execute(select(DeploymentConfig.id).where(DeploymentConfig.id == 1))
        ).scalar_one_or_none()
        if existing is not None:
            return 0
        db.add(DeploymentConfig(id=1, config_json={}))
        await db.commit()
    logger.info("Seeded empty deployment_config row (id=1).")
    return 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(seed_deployment_config())
