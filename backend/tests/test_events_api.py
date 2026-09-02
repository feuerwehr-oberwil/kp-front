"""Audit events (`/api/incidents/{id}/events`, `/snapshot`, `/samples`, `/state`, `/verify`)
— app/api/events.py + app/audit.py's hash chain.

This is the event-sourced replay/legal-record substrate: an editor flushes tactical events
(entity.*, draw.*, …), the server assigns seq + prev_hash + hash so the chain is tamper
evident, and `verify` recomputes it to say so. Contract under test:
- read is any authenticated user, ingest needs an editor (a viewer is refused);
- ingest assigns seq in ARRIVAL order and chains hash→prev_hash, regardless of the client's
  own `occurred_at` — the chain is over ingest order, the timeline is over `occurred_at`;
  a batch replayed twice is NOT deduped (unlike the journal store) — every attempt is a
  fresh, distinct chain link, which is the point of an append-only audit trail;
- `snapshot`/`state` reconstruct from the nearest workspace snapshot <= a requested instant;
- `verify` reports an intact chain, and pinpoints exactly where a tampered one first breaks.

Every incident starts its chain with one `incident.create` event (app/api/incidents.py), so
a freshly created incident is never an empty chain — tests below account for that seq/count
offset rather than assuming seq 1 / count 0.

The Atemschutz-link content rule (link writes only `atemschutz.*`, stamped
source="atemschutz-link") is already covered end-to-end in test_incident_link.py — not
duplicated here.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app import audit, storage
from app.models import IncidentEvent, VehicleSample, WorkspaceSnapshot

pytestmark = pytest.mark.asyncio


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Events Test"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _events(*op_types: str) -> dict:
    return {"events": [{"op_type": op, "payload": {"n": i}} for i, op in enumerate(op_types)]}


async def _snapshot(db_session, incident_id: uuid.UUID, *, occurred_at: datetime, seq_at: int, workspace: dict):
    """A WorkspaceSnapshot row with an explicit `occurred_at`, bypassing `audit.snapshot_workspace`
    (which only ever stamps `func.now()`) so `/snapshot` and `/state` can be tested against
    precisely controlled instants instead of racing the wall clock."""
    key = storage.new_key(f"snapshots/{incident_id}", ".json")
    storage.put_bytes(key, json.dumps(workspace).encode("utf-8"))
    snap = WorkspaceSnapshot(incident_id=incident_id, seq_at=seq_at, storage_key=key, occurred_at=occurred_at)
    db_session.add(snap)
    await db_session.commit()
    return snap


# --- who may read / ingest -----------------------------------------------------------------


async def test_unauthenticated_is_rejected(client):
    inc = uuid.uuid4()
    assert (await client.get(f"/api/incidents/{inc}/events")).status_code == 401
    assert (await client.post(f"/api/incidents/{inc}/events", json={"events": []})).status_code == 401
    assert (await client.get(f"/api/incidents/{inc}/verify")).status_code == 401


async def test_viewer_reads_but_cannot_ingest(client, editor, viewer):
    await _login(client, editor)
    inc = await _incident(client)
    assert (await client.post(f"/api/incidents/{inc}/events", json=_events("draw.create"))).status_code == 201

    await _login(client, viewer)
    assert (await client.get(f"/api/incidents/{inc}/events")).status_code == 200
    r = await client.post(f"/api/incidents/{inc}/events", json=_events("draw.create"))
    assert r.status_code == 403


async def test_unknown_incident_is_404_on_every_endpoint(client, editor):
    await _login(client, editor)
    missing = uuid.uuid4()
    at = datetime.now(UTC).isoformat()
    for method, url, params, body in [
        ("GET", f"/api/incidents/{missing}/events", None, None),
        ("POST", f"/api/incidents/{missing}/events", None, {"events": []}),
        ("GET", f"/api/incidents/{missing}/snapshot", {"at": at}, None),
        ("GET", f"/api/incidents/{missing}/samples", None, None),
        ("GET", f"/api/incidents/{missing}/state", {"at": at}, None),
        ("GET", f"/api/incidents/{missing}/verify", None, None),
    ]:
        r = await client.request(method, url, params=params, json=body)
        assert r.status_code == 404, f"{method} {url} answered {r.status_code}: {r.text[:200]}"
        assert r.json()["detail"] == "Einsatz nicht gefunden"


# --- ingest: chaining, ordering, defaults ---------------------------------------------------


async def test_ingest_assigns_seq_in_arrival_order_and_chains_the_hash(client, editor):
    """Two client-supplied `occurred_at` values arrive out of chronological order — the
    server must still assign seq by ARRIVAL, and each hash must chain onto the previous
    one exactly (prev_hash[n] == hash[n-1], onto the incident's own genesis event)."""
    await _login(client, editor)
    inc = await _incident(client)
    genesis = (await client.get(f"/api/incidents/{inc}/events")).json()[0]  # incident.create, seq 1
    assert genesis["prev_hash"] == audit.GENESIS

    later = datetime(2020, 1, 1, 12, 0, tzinfo=UTC)
    earlier = datetime(2020, 1, 1, 8, 0, tzinfo=UTC)
    r = await client.post(
        f"/api/incidents/{inc}/events",
        json={
            "events": [
                {"op_type": "entity.move", "occurred_at": later.isoformat(), "payload": {}},
                {"op_type": "entity.move", "occurred_at": earlier.isoformat(), "payload": {}},
            ]
        },
    )
    assert r.status_code == 201, r.text
    a, b = r.json()
    assert (a["seq"], b["seq"]) == (2, 3)  # arrival order, not occurred_at order
    assert a["occurred_at"].startswith("2020-01-01T12:00")
    assert b["occurred_at"].startswith("2020-01-01T08:00")
    assert a["prev_hash"] == genesis["hash"]
    assert b["prev_hash"] == a["hash"]
    assert b["hash"] != a["hash"]

    # list_events orders by seq, so the out-of-order occurred_at rows still come back in
    # the order they were appended, not chronological order.
    listed = (await client.get(f"/api/incidents/{inc}/events")).json()
    assert [e["seq"] for e in listed] == [1, 2, 3]


async def test_ingest_defaults_occurred_at_to_now_when_omitted(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    before = datetime.now(UTC)
    r = await client.post(f"/api/incidents/{inc}/events", json={"events": [{"op_type": "layer.toggle"}]})
    assert r.status_code == 201, r.text
    occurred = datetime.fromisoformat(r.json()[0]["occurred_at"])
    assert before - timedelta(seconds=5) <= occurred <= datetime.now(UTC) + timedelta(seconds=5)


async def test_a_replayed_batch_is_not_deduped(client, editor):
    """Unlike the journal store (row `id` is an idempotency key), events have none: a client
    that retries a flush after a lost response appends the SAME events again as fresh chain
    links. This is deliberate for an append-only audit trail (every attempt is recorded), but
    it does mean the client — not this endpoint — owns not double-sending a successful flush."""
    await _login(client, editor)
    inc = await _incident(client)
    batch = _events("draw.create")
    assert (await client.post(f"/api/incidents/{inc}/events", json=batch)).status_code == 201
    r = await client.post(f"/api/incidents/{inc}/events", json=batch)
    assert r.status_code == 201
    listed = (await client.get(f"/api/incidents/{inc}/events")).json()
    assert len(listed) == 3  # incident.create + the two identical flushes
    assert [e["seq"] for e in listed] == [1, 2, 3]


async def test_list_events_filters_by_occurred_at_window(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    stamps = [datetime(2020, 1, 1, h, tzinfo=UTC) for h in (6, 9, 12)]
    await client.post(
        f"/api/incidents/{inc}/events",
        json={"events": [{"op_type": "entity.move", "occurred_at": t.isoformat()} for t in stamps]},
    )
    r = await client.get(
        f"/api/incidents/{inc}/events",
        params={"from_": stamps[1].isoformat(), "to": stamps[1].isoformat()},
    )
    got = r.json()
    assert len(got) == 1  # neither the 06:00/12:00 rows nor the (present-day) incident.create row
    assert got[0]["occurred_at"].startswith("2020-01-01T09:00")


# --- snapshot / state reconstruction ---------------------------------------------------------


async def test_snapshot_reports_not_found_before_any_save(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    r = await client.get(f"/api/incidents/{inc}/snapshot", params={"at": datetime.now(UTC).isoformat()})
    assert r.status_code == 200
    assert r.json() == {"found": False, "occurred_at": None, "seq_at": None, "workspace": None}


async def test_snapshot_and_state_pick_the_nearest_save_at_or_before(client, editor, db_session):
    """Two snapshots and one later plain event, all at explicit, well-separated instants
    (`_snapshot` bypasses `audit.snapshot_workspace`'s `func.now()` for this) — deterministic
    coverage of `nearest_snapshot`'s "<=" boundary and `reconstruct_state`'s "> snapshot" fold,
    instead of racing the wall clock against a real workspace PUT."""
    await _login(client, editor)
    inc = await _incident(client)
    inc_id = uuid.UUID(inc)

    t1 = datetime(2020, 1, 1, 8, tzinfo=UTC)
    between = datetime(2020, 1, 1, 9, tzinfo=UTC)
    t2 = datetime(2020, 1, 1, 10, tzinfo=UTC)
    after = datetime(2020, 1, 1, 11, tzinfo=UTC)

    await _snapshot(db_session, inc_id, occurred_at=t1, seq_at=1, workspace={"v": 1})
    await _snapshot(db_session, inc_id, occurred_at=t2, seq_at=1, workspace={"v": 2})
    r = await client.post(
        f"/api/incidents/{inc}/events",
        json={"events": [{"op_type": "entity.move", "occurred_at": after.isoformat(), "payload": {}}]},
    )
    assert r.status_code == 201, r.text

    # before either snapshot → not found
    r = await client.get(f"/api/incidents/{inc}/snapshot", params={"at": datetime(2020, 1, 1, tzinfo=UTC).isoformat()})
    assert r.json()["found"] is False

    # exactly at t1 → the first snapshot ("<=", not "<")
    r = await client.get(f"/api/incidents/{inc}/snapshot", params={"at": t1.isoformat()})
    body = r.json()
    assert datetime.fromisoformat(body["occurred_at"].replace("Z", "+00:00")) == t1
    assert body["found"] is True
    assert body["seq_at"] == 1
    assert body["workspace"] == {"v": 1}

    # between t1 and t2 → still the first (nearest at-or-before, not the closest in time)
    r = await client.get(f"/api/incidents/{inc}/snapshot", params={"at": between.isoformat()})
    assert r.json()["workspace"] == {"v": 1}

    # at/after t2 → the second
    r = await client.get(f"/api/incidents/{inc}/snapshot", params={"at": t2.isoformat()})
    assert r.json()["workspace"] == {"v": 2}

    # /state between the snapshots: the first snapshot, no events to fold in
    r = await client.get(f"/api/incidents/{inc}/state", params={"at": between.isoformat()})
    state = r.json()
    assert state["workspace"] == {"v": 1}
    assert datetime.fromisoformat(state["snapshot_occurred_at"].replace("Z", "+00:00")) == t1
    assert state["events"] == []

    # /state at `after`: the second (nearest) snapshot, plus the one event strictly after it
    r = await client.get(f"/api/incidents/{inc}/state", params={"at": after.isoformat()})
    state = r.json()
    assert state["workspace"] == {"v": 2}
    assert datetime.fromisoformat(state["snapshot_occurred_at"].replace("Z", "+00:00")) == t2
    assert [e["op_type"] for e in state["events"]] == ["entity.move"]


# --- vehicle samples --------------------------------------------------------------------------


async def test_samples_is_empty_when_nothing_has_been_captured(client, editor):
    """The Traccar→samples capture job isn't wired yet — an incident with no rows must
    answer an empty list, not 404 or an error."""
    await _login(client, editor)
    inc = await _incident(client)
    r = await client.get(f"/api/incidents/{inc}/samples")
    assert r.status_code == 200
    assert r.json() == []


async def test_samples_filters_the_window_and_orders_by_ts(client, editor, db_session):
    await _login(client, editor)
    inc = await _incident(client)
    inc_id = uuid.UUID(inc)
    base = datetime(2020, 1, 1, 6, tzinfo=UTC)
    for i, hour_offset in enumerate((2, 0, 1)):  # inserted out of chronological order
        db_session.add(
            VehicleSample(
                incident_id=inc_id,
                device_id=42,
                ts=base + timedelta(hours=hour_offset),
                lat=47.5 + i * 0.001,
                lng=7.5,
            )
        )
    await db_session.commit()

    r = await client.get(
        f"/api/incidents/{inc}/samples",
        params={"from_": (base + timedelta(minutes=30)).isoformat(), "to": (base + timedelta(hours=3)).isoformat()},
    )
    got = r.json()
    # hour_offset=0 sample excluded by `from_`; the remaining two come back ts-ascending
    assert [s["ts"] for s in got] == sorted(s["ts"] for s in got)
    assert len(got) == 2


# --- verify: the whole point of the hash chain ------------------------------------------------


async def test_verify_reports_an_intact_chain(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    await client.post(f"/api/incidents/{inc}/events", json=_events("draw.create", "entity.move", "undo"))

    r = await client.get(f"/api/incidents/{inc}/verify")
    assert r.status_code == 200
    body = r.json()
    events = (await client.get(f"/api/incidents/{inc}/events")).json()
    assert body == {"intact": True, "broken_at_seq": None, "count": 4, "head": events[-1]["hash"]}


async def test_verify_on_a_freshly_created_incident_is_intact_not_empty(client, editor):
    """`incident.create` is itself a chain link — a brand-new incident's chain is `count: 1`
    off genesis, never `count: 0`."""
    await _login(client, editor)
    inc = await _incident(client)
    events = (await client.get(f"/api/incidents/{inc}/events")).json()
    assert len(events) == 1
    assert events[0]["op_type"] == "incident.create"
    assert events[0]["prev_hash"] == audit.GENESIS

    body = (await client.get(f"/api/incidents/{inc}/verify")).json()
    assert body == {"intact": True, "broken_at_seq": None, "count": 1, "head": events[0]["hash"]}


async def test_verify_pinpoints_a_tampered_payload(client, editor, db_session):
    """The legal-record check: mutate one row after the fact (a tampered `payload_json`,
    which is hashed into the chain) and `verify` must name the FIRST seq where recomputing
    the hash no longer matches what was stored — not just say "broken somewhere"."""
    await _login(client, editor)
    inc = await _incident(client)
    await client.post(f"/api/incidents/{inc}/events", json=_events("draw.create", "entity.move", "entity.move"))

    rows = list(
        (
            await db_session.execute(
                select(IncidentEvent).where(IncidentEvent.incident_id == inc).order_by(IncidentEvent.seq.asc())
            )
        ).scalars()
    )
    tampered = rows[2]  # the first posted "entity.move" (seq 3: incident.create, draw.create, then this)
    assert tampered.op_type == "entity.move"
    tampered.payload_json = {"n": 999}  # was {"n": 1}
    await db_session.commit()

    r = await client.get(f"/api/incidents/{inc}/verify")
    assert r.status_code == 200
    body = r.json()
    assert body["intact"] is False
    assert body["broken_at_seq"] == tampered.seq
    assert body["count"] == 4
    assert "head" not in body  # only reported for an intact chain


async def test_verify_pinpoints_a_forged_hash_even_when_the_payload_matches(client, editor, db_session):
    """A row whose `hash` was rewritten to (wrongly) chain onto a later forged prev_hash: the
    stored fields are internally self-consistent-looking, but recomputing from the true
    predecessor still catches it — the check is against genesis forward, not row-local."""
    await _login(client, editor)
    inc = await _incident(client)
    await client.post(f"/api/incidents/{inc}/events", json=_events("draw.create", "entity.move"))

    rows = list(
        (
            await db_session.execute(
                select(IncidentEvent).where(IncidentEvent.incident_id == inc).order_by(IncidentEvent.seq.asc())
            )
        ).scalars()
    )
    rows[0].hash = "f" * 64  # forge the first link itself
    await db_session.commit()

    body = (await client.get(f"/api/incidents/{inc}/verify")).json()
    assert body["intact"] is False
    assert body["broken_at_seq"] == rows[0].seq
