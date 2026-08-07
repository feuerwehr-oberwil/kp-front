"""Unit tests for the audit-trail hash chain (app.audit).

`compute_hash` and the canonicalisation are pure functions, so we exercise the chain
and tamper-detection logic without a database. We rebuild a chain exactly the way
`append_event` / `verify_chain` do (seq, prev_hash, GENESIS) over plain dicts, then
assert the same recompute that `verify_chain` performs catches any mutation.

This keeps the legally-load-bearing property — "any edit to a recorded event breaks the
chain" — under test with no live server or Postgres.
"""

import uuid
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from sqlalchemy import update

from app.audit import GENESIS, _canonical, append_event, compute_hash, verify_chain
from app.models import Incident, IncidentEvent


def _event_fields(incident_id, seq, op_type, payload, *, occurred_at=None):
    """Mirror the field dict that append_event hashes (and verify_chain recomputes)."""
    occurred = occurred_at or datetime(2026, 6, 19, 12, 0, seq, tzinfo=UTC)
    return {
        "incident_id": str(incident_id),
        "seq": seq,
        "occurred_at": occurred.isoformat(),
        "source": "client",
        "user_id": None,
        "op_type": op_type,
        "payload": payload or {},
    }


def _build_chain(fields_list):
    """Return list of (fields, prev_hash, hash) folding compute_hash over the events."""
    chain = []
    prev = GENESIS
    for fields in fields_list:
        h = compute_hash(prev, fields)
        chain.append((fields, prev, h))
        prev = h
    return chain


def _verify(chain):
    """Reproduce verify_chain's recompute against the stored prev_hash/hash."""
    prev = GENESIS
    for fields, stored_prev, stored_hash in chain:
        expected = compute_hash(prev, fields)
        if stored_prev != prev or stored_hash != expected:
            return {"intact": False, "broken_at_seq": fields["seq"]}
        prev = stored_hash
    return {"intact": True, "broken_at_seq": None, "head": prev}


def test_canonical_is_order_independent():
    a = _canonical({"b": 2, "a": 1})
    b = _canonical({"a": 1, "b": 2})
    assert a == b  # sorted keys → stable hashing input


def test_compute_hash_is_deterministic_and_chained():
    inc = uuid.uuid4()
    f1 = _event_fields(inc, 1, "create", {"x": 1})
    h1a = compute_hash(GENESIS, f1)
    h1b = compute_hash(GENESIS, f1)
    assert h1a == h1b  # deterministic
    assert len(h1a) == 64  # sha256 hex

    f2 = _event_fields(inc, 2, "update", {"x": 2})
    h2 = compute_hash(h1a, f2)
    assert h2 != h1a  # links to previous hash


def test_intact_chain_verifies():
    inc = uuid.uuid4()
    chain = _build_chain(
        [
            _event_fields(inc, 1, "create", {"label": "A"}),
            _event_fields(inc, 2, "move", {"to": [1, 2]}),
            _event_fields(inc, 3, "delete", {}),
        ]
    )
    result = _verify(chain)
    assert result["intact"] is True
    assert result["broken_at_seq"] is None
    assert len(result["head"]) == 64


def test_tampered_payload_breaks_chain():
    inc = uuid.uuid4()
    chain = _build_chain(
        [
            _event_fields(inc, 1, "create", {"label": "A"}),
            _event_fields(inc, 2, "move", {"to": [1, 2]}),
            _event_fields(inc, 3, "delete", {}),
        ]
    )
    # Mutate the middle event's payload in place (hash now stale).
    chain[1][0]["payload"] = {"to": [9, 9]}
    result = _verify(chain)
    assert result["intact"] is False
    assert result["broken_at_seq"] == 2


def test_dropped_event_breaks_chain():
    """Removing an event orphans the prev_hash link of the next one."""
    inc = uuid.uuid4()
    chain = _build_chain(
        [
            _event_fields(inc, 1, "create", {}),
            _event_fields(inc, 2, "move", {}),
            _event_fields(inc, 3, "delete", {}),
        ]
    )
    truncated = [chain[0], chain[2]]  # drop seq 2
    result = _verify(truncated)
    assert result["intact"] is False
    assert result["broken_at_seq"] == 3


# ── The REAL functions, against a real database ────────────────────────────────────────────
# Everything above rebuilds the chain the way append_event/verify_chain do. That mirror is the
# problem: it is a second implementation, and a field added to the hashed dict on one side and
# not the other leaves both green while the legal record silently stops verifying. These
# exercise the actual code paths, including the one thing the mirror cannot reach — a row
# tampered with in the DATABASE, which is how a chain would really be broken.


@pytest_asyncio.fixture
async def incident(db_session):
    inc = Incident(title="Kettenprobe", status="offen", source="manual")
    db_session.add(inc)
    await db_session.flush()
    return inc


@pytest.mark.asyncio
async def test_a_freshly_appended_chain_verifies(db_session, incident):
    for i in range(4):
        await append_event(db_session, incident_id=incident.id, op_type=f"op.{i}", source="test", payload={"i": i})
    await db_session.flush()

    result = await verify_chain(db_session, incident.id)
    assert result == {"intact": True, "broken_at_seq": None, "count": 4, "head": result["head"]}
    assert result["head"] and result["head"] != GENESIS


@pytest.mark.asyncio
async def test_an_edited_payload_breaks_the_chain_at_that_row(db_session, incident):
    """The load-bearing property: change a recorded event and the rapport says so.

    Edited in SQL, not through the API — an attacker with database access is the threat the
    chain exists for, and it is the only path the pure-function tests above cannot take."""
    for i in range(3):
        await append_event(db_session, incident_id=incident.id, op_type=f"op.{i}", source="test", payload={"i": i})
    await db_session.flush()
    assert (await verify_chain(db_session, incident.id))["intact"] is True

    await db_session.execute(
        update(IncidentEvent)
        .where(IncidentEvent.incident_id == incident.id, IncidentEvent.seq == 2)
        .values(payload_json={"i": 999})
    )
    await db_session.flush()
    db_session.expunge_all()

    result = await verify_chain(db_session, incident.id)
    assert result["intact"] is False
    assert result["broken_at_seq"] == 2  # the first bad row, not the last
    assert result["count"] == 3  # every row is still counted — nothing is hidden


@pytest.mark.asyncio
async def test_an_incident_with_no_events_is_intact_not_broken(db_session, incident):
    """A rapport printed before anything was recorded must not read «Hash-Kette gebrochen»."""
    result = await verify_chain(db_session, incident.id)
    assert result["intact"] is True
    assert result["count"] == 0
    assert result["head"] == GENESIS
