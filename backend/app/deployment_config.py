"""The deployment-config singleton — one row, ``deployment_config`` id=1.

Everything a deployment configures about itself hangs off that single row: the config
document, the plan scales, the telemetry consent, and the station-level secrets each
admin surface mints (statistics export, Erfassungs-Poster, Einsatz-Link).

Those secret surfaces are the reason this helper exists. They write to the row *before*
anything has ever written a config document, so each of them needed the same
get-or-create — read id=1, insert an empty row when it is not there yet, flush so the
caller can assign to it. Byte-identical copies of that shape had drifted apart once on what
"empty" means; there is one now.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import DeploymentConfig


async def config_row(db: AsyncSession) -> DeploymentConfig:
    """The singleton row, created empty if this deployment has none yet.

    Flushed before it is handed back, so the caller can set a column on a row that is already
    in the session's identity map. Not committed: it belongs to the caller's transaction.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db.add(row)
        await db.flush()
    return row
