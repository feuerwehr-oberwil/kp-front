"""Small transaction-boundary callbacks for non-database side effects.

Database rows and filesystem/network effects cannot share one atomic transaction.  Writers
therefore register the compensating action at the point where they cross that boundary:

* a newly written blob is removed if the SQL transaction rolls back;
* an obsolete blob or outbound notification is acted on only after commit;
* completion callbacks release process-local locks on either outcome.

Callbacks are deliberately synchronous.  Network modules use them to *schedule* an async
task with its own session; they never try to reuse the just-committed request session.
"""

import logging
from collections.abc import Callable

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

logger = logging.getLogger(__name__)

Callback = Callable[[], None]
RollbackEntry = tuple[SessionTransaction | None, Callback]

_AFTER_COMMIT = "kp_after_commit"
_AFTER_ROLLBACK = "kp_after_rollback"
_AFTER_COMPLETION = "kp_after_completion"


def after_commit(db: AsyncSession, callback: Callback) -> None:
    """Run ``callback`` after this session's outer transaction commits."""
    db.sync_session.info.setdefault(_AFTER_COMMIT, []).append(callback)


def after_rollback(db: AsyncSession, callback: Callback) -> None:
    """Run ``callback`` if the transaction which currently owns the work rolls back.

    Work registered inside a SAVEPOINT is compensated immediately if that savepoint rolls
    back, and remains covered by an eventual outer rollback if the savepoint succeeds.
    """
    session = db.sync_session
    entry: RollbackEntry = (session.get_nested_transaction(), callback)
    session.info.setdefault(_AFTER_ROLLBACK, []).append(entry)


def after_completion(db: AsyncSession, callback: Callback) -> None:
    """Run ``callback`` after either commit or rollback, exactly once."""
    db.sync_session.info.setdefault(_AFTER_COMPLETION, []).append(callback)


def _run(session: Session, key: str) -> None:
    for callback in session.info.pop(key, ()):
        try:
            callback()
        except Exception:  # a cleanup/delivery hook must not falsify a DB commit
            logger.exception("Transaction callback %s failed", key)


@event.listens_for(Session, "after_commit")
def _committed(session: Session) -> None:
    # ``after_commit`` also fires for SAVEPOINT release. These callbacks describe effects
    # paired with the whole request transaction, so a nested success is not enough.
    if session.in_nested_transaction():
        return
    # A committed new blob belongs to the database now; its rollback compensation is stale.
    session.info.pop(_AFTER_ROLLBACK, None)
    _run(session, _AFTER_COMMIT)
    _run(session, _AFTER_COMPLETION)


@event.listens_for(Session, "after_rollback")
def _rolled_back(session: Session) -> None:
    if session.in_nested_transaction():
        # Compensate only work created inside THIS savepoint. Outer registrations remain,
        # because the caller can recover and commit the request transaction.
        nested = session.get_nested_transaction()
        pending: list[RollbackEntry] = session.info.get(_AFTER_ROLLBACK, [])
        inside = [callback for scope, callback in pending if scope is nested]
        session.info[_AFTER_ROLLBACK] = [entry for entry in pending if entry[0] is not nested]
        for callback in inside:
            try:
                callback()
            except Exception:  # a cleanup hook must not hide the original savepoint failure
                logger.exception("Transaction callback %s failed", _AFTER_ROLLBACK)
        return
    # An obsolete blob must remain reachable when the row update did not commit.
    session.info.pop(_AFTER_COMMIT, None)
    for _scope, callback in session.info.pop(_AFTER_ROLLBACK, ()):
        try:
            callback()
        except Exception:  # a cleanup hook must not hide the original transaction failure
            logger.exception("Transaction callback %s failed", _AFTER_ROLLBACK)
    _run(session, _AFTER_COMPLETION)
