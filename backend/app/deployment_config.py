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
  insert an empty row when it is not there yet, read it back so the caller can assign to it.
  Byte-identical copies of that shape had drifted apart once on what "empty" means; there is
  one now.
"""

import copy
import logging

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .models import DeploymentConfig
from .schemas import DeploymentConfigIn, load_stored_config

logger = logging.getLogger(__name__)


#: How many times a repair of over-long parts validates again before it gives up.
_PRUNE_ROUNDS = 10

#: The one pydantic error :func:`safe_config` repairs for serving: a string past its length limit.
_LENGTH_ERROR = "string_too_long"


def safe_config(raw: object) -> DeploymentConfigIn:
    """A stored config document as the validated model, or the shipped defaults.

    Validated as STORED (``schemas · load_stored_config``): a field that has grown a rule since
    it was written is dropped, not refused. A value past a field's LENGTH limit (a
    Korrekturvorschlag label over 120 characters, a Formular URL, a destination folder) is left
    out of what is SERVED, alone, and logged: the outermost list entry that holds it — the whole
    field, link, destination or colour rule, never a half of one — else its key, which then
    reads as its default. The stored row is never changed by a read.

    ⚠️ Before, one such value made the whole document read as ``DeploymentConfigIn()``: every
    device lost the station's name, fleet and roster, and the admin form, which saves the whole
    document, was one «Trotzdem leeren» away from storing those defaults.

    Only when length is ALL that is wrong. Another failing part (a role list, a routing rule)
    can change what the rest MEANS when it is left out: a colour rule without its filter matches
    everything, capture roles fall back to a default that grants access. And pydantic does not
    run a section's own checks (unique ids) while a field inside it fails, so the document is
    first validated with every over-long value CUT to its limit: if that copy fails too, the
    document reads as the shipped defaults, logged. So does a list with more entries than its
    limit (cutting its tail could hide a duplicate id there), and a value whose cut breaks its
    own rule (a folder pattern that loses its last placeholder) — as before, never worse. Never
    raises: where a raise is invisible, the push sweep would stop sending «Trupp überfällig», a
    background worker would stop for good.
    """
    doc = {} if raw is None else raw
    try:
        return load_stored_config(doc)
    except ValidationError:
        pass
    except Exception:  # a bad stored row must never break a reader
        logger.warning("deployment config failed validation; reading the shipped defaults", exc_info=True)
        return DeploymentConfigIn()
    try:
        _repaired(doc, clip=True)  # length is all that is wrong, or the next line never runs
        return _repaired(doc, clip=False)
    except Exception:  # a bad stored row must never break a reader
        logger.warning("deployment config failed validation; reading the shipped defaults", exc_info=True)
        return DeploymentConfigIn()


def _repaired(raw: object, *, clip: bool) -> DeploymentConfigIn:
    """``raw`` validated after its over-long parts were cut to their limit (``clip``) or left out
    (see :func:`_repair_lengths`), on a copy. Raises when anything else fails."""
    doc = copy.deepcopy(raw)  # a read never changes the stored row
    for _ in range(_PRUNE_ROUNDS):
        try:
            return load_stored_config(doc)
        except ValidationError as exc:
            if not _repair_lengths(doc, exc, clip=clip):
                raise
    raise ValueError(f"deployment config still fails after {_PRUNE_ROUNDS} rounds")


def _repair_lengths(doc: object, exc: ValidationError, *, clip: bool) -> bool:
    """Repair in ``doc`` (mutated) each over-long string of ``exc``: cut to its limit with
    ``clip``, else the outermost list entry on its path goes (else the deepest key of it that
    ``doc`` has). False when any error of ``exc`` is another one, so the caller falls back. Logs
    only what it leaves out for serving."""
    errors = exc.errors()
    if any(e["type"] != _LENGTH_ERROR for e in errors):
        return False
    drops: dict[int, tuple[dict | list, set]] = {}
    for error in errors:
        trail, node = _trail(doc, error["loc"])
        limit = (error.get("ctx") or {}).get("max_length")
        if not trail or not isinstance(node, str) or not isinstance(limit, int):
            return False
        if clip:
            parent, key = trail[-1]
            if isinstance(parent, dict):  # noqa: SIM114 – two branches, so mypy narrows each key
                parent[key] = node[:limit]
            elif isinstance(key, int):
                parent[key] = node[:limit]
            continue
        cut = next((i + 1 for i, (parent, _) in enumerate(trail) if isinstance(parent, list)), len(trail))
        parent, key = trail[cut - 1]
        drops.setdefault(id(parent), (parent, set()))[1].add(key)
        logger.warning("deployment config: %s is too long (%s); serving without it", _dotted(trail[:cut]), error["msg"])
    for parent, keys in drops.values():
        for key in sorted(keys, reverse=True):  # list indices from the back, so none shifts
            del parent[key]
    return True


def _trail(doc: object, loc: tuple[int | str, ...]) -> tuple[list[tuple[dict | list, int | str]], object]:
    """The (container, key) steps of an error's path that ``doc`` actually has, and the value
    the last one reaches. It ends early at a union branch name («str») or a key the document
    lacks."""
    trail: list[tuple[dict | list, int | str]] = []
    node = doc
    for key in loc:
        if isinstance(node, list):
            if not (isinstance(key, int) and 0 <= key < len(node)):
                break
            child = node[key]
        elif isinstance(node, dict) and key in node:
            child = node[key]
        else:
            break
        trail.append((node, key))
        node = child
    return trail, node


def _dotted(trail: list[tuple[dict | list, int | str]]) -> str:
    return ".".join(str(key) for _, key in trail)


async def read_config(db: AsyncSession) -> DeploymentConfigIn:
    """The stored config document for a READER — :func:`safe_config` of row id=1.

    A missing row reads as the empty document. Never creates the row and never locks it: a
    read-modify-write takes :func:`config_row` with ``lock=True`` and edits the raw JSON instead.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    return safe_config(row.config_json if row else None)


async def config_row(db: AsyncSession, *, lock: bool = False) -> DeploymentConfig:
    """The singleton row for a WRITER, created empty if this deployment has none yet.

    Already in the database when it is handed back, so the caller can set a column on a row that
    is in the session's identity map. Not committed: it belongs to the caller's transaction.

    Created with ``INSERT … ON CONFLICT DO NOTHING`` and read back, never ``add`` + flush: two
    first writers on a new deployment both find no row, and a plain INSERT made the second one
    fail on the primary key. Now the second INSERT waits for the first transaction, does nothing,
    and the read back (under the lock, with ``lock``) returns the row the first one wrote.

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
    dialect = db.bind.dialect.name if db.bind is not None else "postgresql"
    stmt = select(DeploymentConfig).where(DeploymentConfig.id == 1)
    if lock:
        stmt = stmt.execution_options(populate_existing=True)
        if dialect != "sqlite":
            stmt = stmt.with_for_update()
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        insert = sqlite_insert if dialect == "sqlite" else pg_insert
        await db.execute(insert(DeploymentConfig).values(id=1, config_json=None).on_conflict_do_nothing())
        row = (await db.execute(stmt)).scalar_one()
    return row
