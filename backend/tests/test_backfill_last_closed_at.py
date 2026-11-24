"""Hunt 24.11.2026, data-consistency F7: the data migration f3b8d1a6c2e9 gives an Einsatz that
was closed, reopened and closed again before `last_closed_at` existed its LATER close, from the
audit log – and leaves every other row alone. Runs the real upgrade on a minimal SQLite schema."""

import json
from pathlib import Path
from runpy import run_path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text

MIGRATION = Path(__file__).resolve().parent.parent / "alembic/versions/f3b8d1a6c2e9_backfill_last_closed_at.py"
FIRST, REOPEN, SECOND = "2026-08-01 08:00:00", "2026-08-02 16:00:00", "2026-08-02 18:00:00"


def _upgrade(conn) -> None:
    with Operations.context(MigrationContext.configure(conn)):
        run_path(str(MIGRATION))["upgrade"]()


def test_a_second_close_from_before_the_column_is_backfilled_and_nothing_else_moves():
    with create_engine("sqlite://").begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE incidents (id TEXT, is_archived BOOLEAN, closed_at DATETIME, last_closed_at DATETIME)"
        )
        conn.exec_driver_sql(
            "CREATE TABLE incident_events (incident_id TEXT, seq INTEGER, op_type TEXT, occurred_at DATETIME, payload_json JSON)"
        )
        rows = {
            # closed, reopened, closed again – still stamped with the first close: repaired
            "twice": (True, FIRST, FIRST, [(FIRST, True), (REOPEN, False), (SECOND, True)]),
            # closed once
            "once": (
                True,
                FIRST,
                FIRST,
                [(FIRST, True), (REOPEN, {"report_done": True}), (SECOND, {"to": "erledigt"})],
            ),
            # already stamped with its later close (closed after the column existed)
            "stamped": (True, FIRST, "2026-08-03 09:00:00", [(FIRST, True), (REOPEN, False), (SECOND, True)]),
            # reopened and still running: its next close stamps itself
            "running": (False, FIRST, FIRST, [(FIRST, True), (REOPEN, False)]),
        }
        for inc, (archived, closed, last, history) in rows.items():
            conn.execute(
                text("INSERT INTO incidents VALUES (:id, :a, :c, :l)"),
                {"id": inc, "a": archived, "c": closed, "l": last},
            )
            for seq, (at, what) in enumerate(history, start=1):
                payload = {"archived": what} if isinstance(what, bool) else what
                conn.execute(
                    text("INSERT INTO incident_events VALUES (:id, :seq, 'status.change', :at, :p)"),
                    {"id": inc, "seq": seq, "at": at, "p": json.dumps(payload)},
                )
        _upgrade(conn)
        _upgrade(conn)  # idempotent: a second run changes nothing
        got = {i: str(t)[:19] for i, t in conn.exec_driver_sql("SELECT id, last_closed_at FROM incidents").all()}
        closed = dict(conn.exec_driver_sql("SELECT id, closed_at FROM incidents").all())
    assert got == {"twice": SECOND, "once": FIRST, "stamped": "2026-08-03 09:00:00", "running": FIRST}
    assert set(closed.values()) == {FIRST}  # the first close (Nachträge) is never touched
