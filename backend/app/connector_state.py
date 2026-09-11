"""Recording what a connector last did — the write half of :class:`models.ConnectorState`.

Every caller is an unattended job, so the rules here are about not making things worse:

* **A record never fails its caller.** :func:`record` is called from inside jobs whose real
  work has already succeeded or already failed; a status row that cannot be written must not
  turn a working poll into a logged exception. It returns whether it wrote and swallows nothing
  else.
* **A failure is never a success.** ``last_success_at`` moves only on ``ok=True``, and the
  reader is expected to show both timestamps — see the model's docstring.
* **An error line never carries a credential.** :func:`safe_error` quotes only the exception
  types that are URL-free by construction; everything else leaves as its type name, the way
  ``api/personnel._divera_unreachable`` does for the same Divera calls.

The throttle exists for exactly one caller (the 30 s Traccar sweep) and is deliberately a
parameter rather than a second function: «write at most this often, unless something changed»
is one rule, and a connector that ticks slowly simply passes 0.
"""

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import ConnectorState

logger = logging.getLogger(__name__)

#: The alarm intake — the 120 s Divera poll AND the webhook, which is the primary path.
DIVERA_ALARMS = "divera_alarms"
#: The vehicle feed, sampled every 30 s. The one throttled writer.
TRACCAR = "traccar"
#: The Mannschaft sync — the nightly autosync and the hand-triggered execute.
DIVERA_PERSONNEL = "divera_personnel"

#: Every connector this table knows about, in the order a status surface reads best.
NAMES = (DIVERA_ALARMS, TRACCAR, DIVERA_PERSONNEL)

#: How long a repeated, unchanged report may be suppressed (the Traccar sweep's value).
TRACCAR_THROTTLE_SECONDS = 300

#: What we last PERSISTED per connector, in this process: ``(when, ok, error)``.
#:
#: In memory rather than read back, for the reason `scheduler._last_sample` is: the question is
#: «did WE just write this», the answer is worth nothing after a restart, and getting it wrong
#: costs one extra row update. A restart therefore always writes once, which is honest — it is
#: where things stood when we came up.
_last_written: dict[str, tuple[datetime, bool, str | None]] = {}


async def _row(db: AsyncSession, name: str) -> ConnectorState | None:
    return (await db.execute(select(ConnectorState).where(ConnectorState.name == name))).scalar_one_or_none()


def safe_error(exc: BaseException) -> str:
    """One operator-readable line for ``last_error`` — never the exception's own text blindly.

    ⚠️ An ``httpx.HTTPStatusError`` stringifies to «… for url '…?accesskey=<the key>'», and this
    column is served to the admin System card. Only the two types that are URL-free by
    construction are quoted: ``DiveraApiError`` (which carries the status code and nothing else)
    and our own ``ValueError`` messages. Everything else leaves as its type name.
    """
    from .divera import DiveraApiError

    text = str(exc) if isinstance(exc, DiveraApiError | ValueError) else ""
    return (text or type(exc).__name__)[:400]


async def record(
    db: AsyncSession,
    name: str,
    *,
    ok: bool,
    error: str | None = None,
    detail: dict | None = None,
    throttle_seconds: int = 0,
) -> bool:
    """Write this connector's attempt. Returns whether a row was actually touched.

    The caller still owns the commit — every writer here is already inside a job or a request
    that commits, and a second commit in the middle of one would break its transaction.

    With ``throttle_seconds``, an UNCHANGED report (same ``ok``, same ``error``) inside the
    window is skipped. A transition is always written: the first failure after successes lands
    immediately, which is the whole point of the surface.
    """
    now = datetime.now(UTC)
    previous = _last_written.get(name)
    if (
        throttle_seconds
        and previous is not None
        and previous[1] == ok
        and previous[2] == error
        and (now - previous[0]).total_seconds() < throttle_seconds
    ):
        return False

    row = await _row(db, name)
    if row is None:
        # ⚠️ Flushed inside a SAVEPOINT, not left pending, and the loser of the race re-reads.
        # Two things go wrong otherwise. These sessions run with autoflush OFF, so a second
        # record() in the same transaction would not SEE a pending row and would add a second
        # one under the same primary key; and the first row of all is genuinely contended —
        # two Divera webhook deliveries land together often enough that «the first alarm of
        # the year 500s» would be a real failure. The savepoint is what keeps the integrity
        # error from poisoning the transaction the caller is still using.
        try:
            async with db.begin_nested():
                row = ConnectorState(name=name)
                db.add(row)
                await db.flush()
        except IntegrityError:
            row = await _row(db, name)
            if row is None:  # lost the race to a transaction we cannot see yet — report nothing
                logger.warning("Could not create the %s connector row", name, exc_info=True)
                return False
    row.last_attempt_at = now
    if ok:
        row.last_success_at = now
        row.last_error = None
    else:
        row.last_error = error
    if detail is not None:
        row.detail = detail
    _last_written[name] = (now, ok, error)
    return True


async def record_failure(db: AsyncSession, name: str, exc: BaseException, *, throttle_seconds: int = 0) -> None:
    """Record a failed run on a session whose transaction the failure already rolled back.

    The jobs all follow «rollback, log, then say so», and by then the session is clean — so this
    commits on its own and swallows anything that goes wrong doing it. A status row is worth
    less than the job it is reporting on.

    ``throttle_seconds`` suppresses only an IDENTICAL repeat inside the window: the first
    failure after a success, and any failure whose reason changed, are written at once.
    """
    try:
        await record(db, name, ok=False, error=safe_error(exc), throttle_seconds=throttle_seconds)
        await db.commit()
    except Exception:  # noqa: BLE001 — reporting a failure must never become a second one
        await db.rollback()
        logger.warning("Could not record the %s connector failure", name, exc_info=True)


def as_json(row: ConnectorState | None) -> dict:
    """The status-card projection: ISO timestamps, null-safe, same keys for an absent row.

    A connector that has never run gets nulls rather than no keys at all — a reader that has to
    tell «never ran» from «this build does not report it» is a reader that will get it wrong.

    ⚠️ The stored ``detail`` column is served as ``counts``: a connector row on ``/api/system``
    already has a ``detail``, and that one is a STRING (the print relay's last-seen stamp). Two
    fields of the same name and different types in one row is how a reader ends up rendering an
    object into a date.
    """
    return {
        "lastAttempt": row.last_attempt_at.isoformat() if row and row.last_attempt_at else None,
        "lastSuccess": row.last_success_at.isoformat() if row and row.last_success_at else None,
        "lastError": row.last_error if row else None,
        "counts": (row.detail if row else None) or None,
    }


async def states(db: AsyncSession) -> dict[str, dict]:
    """Every known connector's projection, keyed by name — absent rows included."""
    rows = {r.name: r for r in (await db.execute(select(ConnectorState))).scalars()}
    return {name: as_json(rows.get(name)) for name in NAMES}


def reset_memo() -> None:
    """Forget the per-process throttle memo. For tests, and for nothing else."""
    _last_written.clear()
