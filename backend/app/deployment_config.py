"""The deployment-config singleton — one row, ``deployment_config`` id=1.

Everything a deployment configures about itself hangs off that single row: the config
document, the plan scales, and the station-level secrets each
admin surface mints (statistics export, Erfassungs-Poster, Einsatz-Link).

Two ways in, one per side:

* READERS of the config document call :func:`read_config` (or :func:`safe_config` on a raw
  document they already hold). It is the one validated read, and it never raises on the
  document — see there. A reader that needs the raw JSON on purpose reads the column itself
  and says why: a version hash, a key the schema drops, or a value that feeds an unattended
  write (the roster sync, the snapshot cap, the area jobs, unattended geocoding), where the
  fallback's defaults would write something the station did not choose.
* WRITERS take :func:`config_row`. The secret surfaces write to the row *before* anything has
  ever written a config document, so each of them needed the same get-or-create — read id=1,
  insert an empty row when it is not there yet, flush so the caller can assign to it.
  Byte-identical copies of that shape had drifted apart once on what "empty" means; there is
  one now.
"""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import DeploymentConfig
from .schemas import DeploymentConfigIn, load_stored_config

logger = logging.getLogger(__name__)


def safe_config(raw: object) -> DeploymentConfigIn:
    """A stored config document as the validated model, or the shipped defaults.

    Validated as STORED (``schemas · load_stored_config``): a field that has grown a rule since
    it was written is dropped, not refused. A document that fails even that (a hand-edited row)
    is logged and answered with ``DeploymentConfigIn()`` — every reader then sees the shipped
    defaults instead of an exception. That matters most where a raise is invisible: the push
    sweep would stop sending «Trupp überfällig», a background worker would stop for good.
    """
    try:
        return load_stored_config({} if raw is None else raw)
    except Exception:  # a bad stored row must never break a reader
        logger.warning("deployment config failed validation; reading the shipped defaults", exc_info=True)
        return DeploymentConfigIn()


async def read_config(db: AsyncSession) -> DeploymentConfigIn:
    """The stored config document for a READER — :func:`safe_config` of row id=1.

    A missing row reads as the empty document. Never creates the row and never locks it: a
    read-modify-write takes :func:`config_row` with ``lock=True`` and edits the raw JSON instead.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    return safe_config(row.config_json if row else None)


async def config_row(db: AsyncSession, *, lock: bool = False) -> DeploymentConfig:
    """The singleton row for a WRITER, created empty if this deployment has none yet.

    Flushed before it is handed back, so the caller can set a column on a row that is already
    in the session's identity map. Not committed: it belongs to the caller's transaction.

    ``lock`` takes the row FOR UPDATE and re-reads it from the database, for a writer that does
    read-modify-write on ``config_json``. That is every writer of this document — there are no
    partial writes. A version check must run UNDER this lock too: ``If-Match`` alone lets two
    overlapping requests both accept one version before either writes. Read-modify-write
    imports take it before PLANNING, not only before assigning the replacement. This also
    serialises their history snapshots with the write they describe.

    ``populate_existing`` matters as much as the lock: without it the
    identity map would hand back the copy this session loaded BEFORE waiting for the lock, which
    is the stale document the lock was taken to avoid reading.

    ⚠️ The FOR UPDATE half degrades to nothing on SQLite, which has no row locking and where the
    tests run. That is sound — SQLite serialises writers at the file — but it means a test cannot
    prove the Postgres half. The re-read is dialect-agnostic and stays on either way, so what a
    test CAN prove is that a merge reads the row as it stands and preserves what it did not touch.
    """
    stmt = select(DeploymentConfig).where(DeploymentConfig.id == 1)
    if lock:
        stmt = stmt.execution_options(populate_existing=True)
        if (db.bind.dialect.name if db.bind is not None else "postgresql") != "sqlite":
            stmt = stmt.with_for_update()
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db.add(row)
        await db.flush()
    return row
