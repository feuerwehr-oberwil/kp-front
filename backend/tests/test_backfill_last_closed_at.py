"""Hunt 24.11.2026, data-consistency F7: the data migration f3b8d1a6c2e9 gives an Einsatz still
stamped with its FIRST close the later close its audit log shows – and leaves every other row
alone. Runs the real upgrade on a minimal SQLite schema."""

import json
from pathlib import Path
from runpy import run_path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text

MIGRATION = Path(__file__).resolve().parent.parent / "alembic/versions/f3b8d1a6c2e9_backfill_last_closed_at.py"
FIRST, REOPEN, SECOND = "2026-08-01 08:00:00", "2026-08-02 16:00:00", "2026-08-02 18:00:00"
LATER = "2026-08-03 09:00:00"
CLOSE, OPEN = {"archived": True}, {"archived": False}

#: id → (is_archived, status, closed_at, last_closed_at, [(occurred_at, payload, source)], expected)
ROWS = {
    # closed, reopened, closed again – still stamped with the first close: repaired
    "twice": (
        True,
        "offen",
        FIRST,
        FIRST,
        [(FIRST, CLOSE, "status"), (REOPEN, OPEN, "status"), (SECOND, CLOSE, "status")],
        SECOND,
    ),
    # closed once (a report_done event is no lifecycle change; the stamp lags the event by ms)
    "once": (
        True,
        "offen",
        FIRST,
        FIRST,
        [("2026-08-01 08:00:00.004", CLOSE, "status"), (REOPEN, {"report_done": True}, "status")],
        FIRST,
    ),
    # already stamped with its later close (closed after the column existed)
    "stamped": (
        True,
        "offen",
        FIRST,
        LATER,
        [(FIRST, CLOSE, "status"), (REOPEN, OPEN, "status"), (SECOND, CLOSE, "status")],
        LATER,
    ),
    # closed twice, then reopened again and still running: its next close stamps itself
    "running": (
        False,
        "offen",
        FIRST,
        FIRST,
        [(FIRST, CLOSE, "status"), (REOPEN, OPEN, "status"), (SECOND, CLOSE, "status"), (LATER, OPEN, "status")],
        FIRST,
    ),
    # the same shape, but written by a client: only server-written lifecycle events count
    "client": (
        True,
        "offen",
        FIRST,
        FIRST,
        [(FIRST, CLOSE, "status"), (REOPEN, OPEN, "client"), (SECOND, CLOSE, "client")],
        FIRST,
    ),
    # reopened, then closed by a status rather than the archive flag
    "by-status": (
        False,
        "abgeschlossen",
        FIRST,
        FIRST,
        [
            (FIRST, CLOSE, "status"),
            (REOPEN, OPEN, "status"),
            (SECOND, {"from": "offen", "to": "abgeschlossen"}, "status"),
        ],
        SECOND,
    ),
    # a FireHub «Einsatzende» stamped closed_at, the card was closed later
    "firehub": (
        True,
        "offen",
        FIRST,
        FIRST,
        [(FIRST, {"source": "firehub", "einsatzende": FIRST}, "status"), (SECOND, CLOSE, "status")],
        SECOND,
    ),
    # a device clock put the reopen before the first close: seq order decides, not the clock
    "skew": (
        True,
        "offen",
        FIRST,
        FIRST,
        [(FIRST, CLOSE, "status"), ("2026-08-01 07:59:00", OPEN, "status"), (SECOND, CLOSE, "status")],
        SECOND,
    ),
}


def _upgrade(conn) -> None:
    with Operations.context(MigrationContext.configure(conn)):
        run_path(str(MIGRATION))["upgrade"]()


def _stamps(conn, column: str) -> dict[str, str]:
    rows = conn.exec_driver_sql("SELECT id, closed_at, last_closed_at FROM incidents").all()
    return {i: str(last if column == "last_closed_at" else first)[:19] for i, first, last in rows}


def test_the_later_close_is_backfilled_from_the_server_lifecycle_and_nothing_else_moves():
    with create_engine("sqlite://").begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE incidents (id TEXT, is_archived BOOLEAN, status TEXT, closed_at DATETIME, last_closed_at DATETIME)"
        )
        conn.exec_driver_sql(
            "CREATE TABLE incident_events (incident_id TEXT, seq INTEGER, source TEXT, op_type TEXT, "
            "occurred_at DATETIME, payload_json JSON)"
        )
        for inc, (archived, status, closed, last, history, _) in ROWS.items():
            conn.execute(
                text("INSERT INTO incidents VALUES (:id, :a, :s, :c, :l)"),
                {"id": inc, "a": archived, "s": status, "c": closed, "l": last},
            )
            for seq, (at, payload, source) in enumerate(history, start=1):
                conn.execute(
                    text("INSERT INTO incident_events VALUES (:id, :seq, :src, 'status.change', :at, :p)"),
                    {"id": inc, "seq": seq, "src": source, "at": at, "p": json.dumps(payload)},
                )
        expected = {inc: row[-1] for inc, row in ROWS.items()}
        _upgrade(conn)
        assert _stamps(conn, "last_closed_at") == expected
        _upgrade(conn)  # idempotent: a second run changes nothing
        assert _stamps(conn, "last_closed_at") == expected
        # the first close (it marks the Nachträge) is never touched
        assert set(_stamps(conn, "closed_at").values()) == {FIRST}
