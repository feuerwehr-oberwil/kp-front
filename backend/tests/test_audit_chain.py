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

from app.audit import GENESIS, _canonical, compute_hash


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
