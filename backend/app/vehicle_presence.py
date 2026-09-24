"""Vehicle presence, observed ONCE, by the server: «vor Ort» / «hat den Einsatzort verlassen».

Why this is server-side (24.09.2026, post-mortem of the Feueralarm-Übung on 23.09.2026). The
client hook this replaces (`src/lib/useVehiclePresenceLog.ts`, deleted) ran on every editor
device and stamped a transition at the moment THAT device noticed it. #204 made its row ids
deterministic, so three tablets converged on one row — but the time on the row was still «when
some device woke up»: GPS had the first three vehicles on scene at 19:23–19:24, the Verlauf had all five
vehicles at 19:43, the moment the tablet was unlocked. A vehicle's arrival is a fact about the
GPS track, not about a screen, so the one process that sees every fix whether or not anybody is
looking — the scheduler's 30 s sweep — records it, stamped with the FIX time.

The rules are the client's, number for number (keep them identical — a mixed-version day
compares the two):

* ≤ ``AT_SCENE_M`` is «vor Ort», ≥ ``LEFT_M`` is «weg», the band between says nothing (it
  neither starts nor ends a state — see `zone_of`);
* a new zone has to hold for ``SETTLE_S`` before it counts, and the transition is stamped with
  the FIRST fix seen in the new zone;
* the first reading of a vehicle is a silent BASELINE, never a row: an Einsatz opened with the
  TLF already parked at the scene has no arrival time anybody can know.

What reaches the record (D2, ★ picks):

* one ``vehicle.presence`` audit event per transition (and one for the baseline), under the
  derived id ``vp:<device>:<n>`` — the machine record every later tick, restart or second
  worker rebuilds from and converges on;
* the Verlauf gets the FIRST arrival and the LAST departure per vehicle, nothing in between
  (D2-a): a supply vehicle's five runs to the depot are counted («5 Fahrten») in `reportMeta.fahrzeuge` and
  shown in the vehicle table and the Rapport. «Last» is only known once the vehicle stays away,
  so a departure's row is written when the vehicle has been gone ``FINAL_AWAY_S`` — or when the
  Einsatz stops being active — stamped with the departure's own fix time. The Verlauf orders by
  `at`, so the row stands where it happened;
* the Rapport's clocks through the same blob the external geofence writes
  (`api/alarms · apply_milestones`): ``vorOrt`` = first arrival, ``zurueck`` = last departure.
  FIRST WRITER WINS between the two writers (D2-b), per field, and `manual` rows keep their
  times; the server records which fields are its own in ``gps.owns``.

Row ids keep the shape the client wrote (`vp-<n>-<zone>-gps-<device>`), so a device still
running the previous build reads the server's rows as «already written» — and whatever it
writes anyway is dropped at the journal endpoint (`api/journal · observed_by_server`).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .geo_util import haversine_m
from .traccar import VehiclePosition

logger = logging.getLogger(__name__)

#: Inside this ring the vehicle is «vor Ort» (same number as the client hook it replaces).
AT_SCENE_M = 150.0
#: …and it has to get this far out before it counts as gone. The gap is hysteresis: one
#: threshold plus 30–40 m of GPS scatter writes arrivals and departures for a parked truck.
LEFT_M = 300.0
#: How long a new zone has to hold before it is a transition.
SETTLE_S = 90
#: How long a vehicle has to stay away before its departure is the LAST one — see the module
#: docstring. Longer than a shuttle run to the Magazin (≈ 10 min in the Übung), short enough that
#: the Verlauf has the row while the Einsatz is still being worked.
FINAL_AWAY_S = 20 * 60

Zone = Literal["scene", "away"]

OP_TYPE = "vehicle.presence"
EVENT_SOURCE = "gps"


def zone_of(distance_m: float) -> Zone | None:
    """The ring this reading is in, or None for the band between — «unchanged», not a zone."""
    if distance_m <= AT_SCENE_M:
        return "scene"
    if distance_m >= LEFT_M:
        return "away"
    return None


def vehicle_key(device_id: int) -> str:
    """The id the map gives the vehicle (`useVehiclePositions · toEntity`) — the row's
    `entityId` and the tail of its id, so the client's old reader finds the server's rows."""
    return f"gps-{device_id}"


def row_id(n: int, zone: Zone, device_id: int) -> str:
    return f"vp-{n}-{zone}-{vehicle_key(device_id)}"


def event_id(device_id: int, n: int) -> str:
    return f"vp:{device_id}:{n}"


@dataclass(frozen=True)
class Presence:
    """What is known about one vehicle at one Einsatz."""

    zone: Zone
    #: transition number of the last recorded transition; 0 = only the baseline so far
    n: int
    #: stays on scene so far — a baseline «scene» is the first
    fahrten: int
    first_arrival: datetime | None = None
    last_departure: datetime | None = None
    #: a departure whose Verlauf row is not written yet (its fix time); None = nothing owed
    departure_owed: datetime | None = None
    #: the zone being settled into, its first fix (the stamp), and when the server first saw it
    pending: Zone | None = None
    pending_fix: datetime | None = None
    pending_seen: datetime | None = None


@dataclass(frozen=True)
class Step:
    #: None only while a vehicle with no record has been read in the band
    state: Presence | None
    #: this reading established the baseline (record it; no row)
    baseline: bool = False
    #: this reading completed a transition into this zone
    transition: Zone | None = None


def step(state: Presence | None, distance_m: float, fix_at: datetime, now: datetime) -> Step:
    """Advance one vehicle by one reading. Pure; mirrors the client hook's state machine.

    `fix_at` is the GPS fix time (the stamp); `now` the server clock (the settle also completes
    on wall time, so a tracker that stops reporting once parked — Traccar re-serves its last fix
    forever — still settles, exactly as it did on the devices).
    """
    zone = zone_of(distance_m)
    if zone is None:
        # the band: no state starts, no state ends
        return Step(replace(state, pending=None, pending_fix=None, pending_seen=None) if state else None)
    if state is None:
        return Step(Presence(zone=zone, n=0, fahrten=1 if zone == "scene" else 0), baseline=True)
    if zone == state.zone:
        return Step(replace(state, pending=None, pending_fix=None, pending_seen=None))
    if state.pending != zone or state.pending_fix is None or state.pending_seen is None:
        return Step(replace(state, pending=zone, pending_fix=fix_at, pending_seen=now))
    settled = (fix_at - state.pending_fix).total_seconds() >= SETTLE_S or (
        now - state.pending_seen
    ).total_seconds() >= SETTLE_S
    if not settled:
        return Step(state)
    at = state.pending_fix
    if zone == "scene":
        nxt = Presence(
            zone="scene",
            n=state.n + 1,
            fahrten=state.fahrten + 1,
            # the FIRST stay only: a vehicle that was already on scene when the Einsatz opened
            # (baseline «scene») and comes back from a trip has no arrival anybody can know
            first_arrival=state.first_arrival or (at if state.fahrten == 0 else None),
            last_departure=state.last_departure,
            # the vehicle came back: the departure before was a trip, not the last one
            departure_owed=None,
        )
    else:
        nxt = Presence(
            zone="away",
            n=state.n + 1,
            fahrten=state.fahrten,
            first_arrival=state.first_arrival,
            last_departure=at,
            departure_owed=at,
        )
    return Step(nxt, transition=zone)


def departure_due(state: Presence, now: datetime, *, closing: bool = False) -> bool:
    """Is the owed departure row due — the vehicle stayed away, or the Einsatz is ending?"""
    if state.zone != "away" or state.departure_owed is None:
        return False
    return closing or (now - state.departure_owed).total_seconds() >= FINAL_AWAY_S


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _parse(raw: object) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def event_payload(p: VehiclePosition, state: Presence, vehicle: str | None) -> dict:
    """The event carries the whole state after the step, so the LAST event is a restart's
    complete memory (no fold over the chain needed). Nothing device-local, nothing that differs
    between two workers computing the same transition."""
    return {
        "device_id": p.device_id,
        "name": p.device_name,
        "vehicle": vehicle,
        "zone": state.zone,
        "n": state.n,
        "fahrten": state.fahrten,
        "first_arrival": _iso(state.first_arrival),
        "last_departure": _iso(state.last_departure),
    }


def state_from_event(payload: dict, *, departure_logged: bool) -> Presence | None:
    zone = payload.get("zone")
    if zone not in ("scene", "away"):
        return None
    last_departure = _parse(payload.get("last_departure"))
    return Presence(
        zone=zone,
        n=int(payload.get("n") or 0),
        fahrten=int(payload.get("fahrten") or 0),
        first_arrival=_parse(payload.get("first_arrival")),
        last_departure=last_departure,
        departure_owed=last_departure if zone == "away" and not departure_logged and last_departure else None,
    )


def fleet_vehicle_for(p: VehiclePosition, fleet: list) -> str | None:
    """The `fleet.vehicles[].id` this tracker is. The config's rule is «`id` equals the
    sender's device name»; compared without case (a Traccar name «TLF», an id «tlf»), and the
    label and the tracker's unique id are accepted too. None = not a station vehicle (a private
    tracker, a Kommandowagen nobody configured) — it still gets its Verlauf rows, but no line in
    the Rapport's Fahrzeugzeiten."""
    names = {n.strip().lower() for n in (p.device_name, p.unique_id) if n}
    for v in fleet:
        if v.id.strip().lower() in names or v.label.strip().lower() in names:
            return str(v.id)
    return None


# --- the blob ----------------------------------------------------------------------------


def apply_gps_presence(
    ws: dict | None, vehicle_id: str, state: Presence, device_id: int | None = None
) -> tuple[dict, bool, bool]:
    """Pure upsert of one vehicle's GPS presence into `reportMeta.fahrzeuge`.

    Writes the `gps` block (zone, an, ab, fahrten, owns — the vehicle table and the
    Rapport's «n Fahrten» read it) on every row, and the Rapport's own clocks where the server
    may: `vorOrt` (first arrival) and `zurueck` (last departure) only if nobody else wrote them
    first, and never on a `manual` row. Returns (new_ws, changed, arrival_is_ours) — the last
    says whether the Rapport's «vor Ort» is this observation's, which is when the server's
    arrival row is not a duplicate of the external geofence's «TLF vor Ort 19:23».
    """
    base = dict(ws or {})
    rm = dict(base.get("reportMeta") or {})
    fahrzeuge = [dict(v) for v in (rm.get("fahrzeuge") or []) if isinstance(v, dict)]
    cur = next((v for v in fahrzeuge if v.get("id") == vehicle_id), None)
    if cur is None:
        cur = {"id": vehicle_id}
        fahrzeuge.append(cur)
    before = dict(cur)
    prev_gps = cur.get("gps")
    prev_owns = prev_gps.get("owns") if isinstance(prev_gps, dict) else None
    owns = [f for f in (prev_owns or []) if f in ("vorOrt", "zurueck")]
    if not cur.get("manual"):
        for field, value in (("vorOrt", state.first_arrival), ("zurueck", state.last_departure)):
            if value is None:
                continue
            if cur.get(field) is None or field in owns:
                cur[field] = value.isoformat()
                if field not in owns:
                    owns.append(field)
    gps: dict = {"zone": state.zone, "fahrten": state.fahrten}
    if device_id is not None:
        # the tracker, so the vehicle table can put the live fix age beside the row (gps-<id>)
        gps["device"] = device_id
    if state.first_arrival:
        gps["an"] = state.first_arrival.isoformat()
    if state.last_departure:
        gps["ab"] = state.last_departure.isoformat()
    if owns:
        gps["owns"] = owns
    cur["gps"] = gps
    changed = cur != before
    arrival_ours = "vorOrt" in owns or bool(cur.get("manual"))
    rm["fahrzeuge"] = fahrzeuge
    base["reportMeta"] = rm
    return base, changed, arrival_ours


# --- the tick ----------------------------------------------------------------------------

#: (incident, device) → what is known; a key present with None = «no record, no reading yet
#: outside the band» (so a cold vehicle in the band does not re-query every tick).
_state: dict[tuple[str, int], Presence | None] = {}


def reset_state() -> None:
    """Tests, and nothing else."""
    _state.clear()


async def _rebuild(db: AsyncSession, incident_id: uuid.UUID, device_id: int) -> Presence | None:
    """A cold memo (restart, first tick of a new leader) reads the LAST presence event back."""
    from .models import IncidentEvent, JournalEntry

    ev = (
        await db.execute(
            select(IncidentEvent.payload_json)
            .where(
                IncidentEvent.incident_id == incident_id,
                IncidentEvent.op_type == OP_TYPE,
                IncidentEvent.client_id.like(f"vp:{device_id}:%"),
            )
            .order_by(IncidentEvent.seq.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not isinstance(ev, dict):
        return None
    logged = False
    if ev.get("zone") == "away":
        rid = row_id(int(ev.get("n") or 0), "away", device_id)
        logged = (
            await db.execute(
                select(JournalEntry.id).where(JournalEntry.incident_id == incident_id, JournalEntry.client_id == rid)
            )
        ).first() is not None
    return state_from_event(ev, departure_logged=logged)


async def _record_event(
    db: AsyncSession, incident_id: uuid.UUID, p: VehiclePosition, state: Presence, vehicle: str | None, at: datetime
) -> None:
    from . import audit

    try:
        await audit.append_event(
            db,
            incident_id=incident_id,
            op_type=OP_TYPE,
            source=EVENT_SOURCE,
            payload=event_payload(p, state, vehicle),
            occurred_at=at,
            client_id=event_id(p.device_id, state.n),
        )
    except audit.EventIdentityConflictError:
        # a second writer recorded this transition number first, with a different reading —
        # its record stands (first writer wins), and ours converges on it at the next rebuild
        logger.info("Presence event %s already recorded differently; keeping the first", event_id(p.device_id, state.n))


def _row(n: int, zone: Zone, p: VehiclePosition, at: datetime, label: str) -> dict:
    text = f"{label} vor Ort" if zone == "scene" else f"{label} hat den Einsatzort verlassen"
    return {
        "id": row_id(n, zone, p.device_id),
        "t": "",
        "at": at.isoformat(),
        "icon": "truck",
        "text": text,
        "kind": "symbol",
        "surface": "map",
        "entityId": vehicle_key(p.device_id),
    }


@dataclass
class _Incident:
    id: uuid.UUID
    lat: float
    lng: float


async def active_incidents(db: AsyncSession, now: datetime) -> list[_Incident]:
    """«Active» for everything the server observes: open (`Incident.is_open`), started within
    the last 24 h, with a real coordinate (0/0 is Divera's «no location»). Übungen included —
    the Übung is where this gets tested."""
    from .models import INCIDENT_ACTIVE_STATUSES, Incident

    rows = (
        await db.execute(
            select(Incident.id, Incident.lat, Incident.lng).where(
                Incident.is_archived.is_(False),
                Incident.status.in_(INCIDENT_ACTIVE_STATUSES),
                Incident.started_at >= now - timedelta(hours=24),
                Incident.lat.is_not(None),
                Incident.lng.is_not(None),
            )
        )
    ).all()
    out: list[_Incident] = []
    for iid, lat, lng in rows:
        la, ln = float(lat), float(lng)
        if la == 0 and ln == 0:
            continue
        out.append(_Incident(iid, la, ln))
    return out


async def running_incident_exists(db: AsyncSession, now: datetime) -> bool:
    """An Einsatz is running: open and started within the last 24 h (a coordinate is not asked
    for — this is the Divera poll's cadence question, not a geometry one)."""
    from .models import INCIDENT_ACTIVE_STATUSES, Incident

    return (
        await db.execute(
            select(Incident.id)
            .where(
                Incident.is_archived.is_(False),
                Incident.status.in_(INCIDENT_ACTIVE_STATUSES),
                Incident.started_at >= now - timedelta(hours=24),
            )
            .limit(1)
        )
    ).first() is not None


async def _store_blob(
    db: AsyncSession, incident_id: uuid.UUID, vehicle_id: str, state: Presence, device_id: int
) -> bool:
    """CAS the gps block into the blob; returns whether the Rapport's «vor Ort» is ours."""
    from .api.alarms import cas_workspace

    ours = False

    def mutate(ws: dict | None) -> tuple[dict, bool]:
        nonlocal ours
        new_ws, changed, ours = apply_gps_presence(ws, vehicle_id, state, device_id)
        return new_ws, changed

    await cas_workspace(db, incident_id, mutate)
    return ours


async def _flush_departure(
    db: AsyncSession, incident_id: uuid.UUID, p: VehiclePosition, state: Presence, label: str
) -> Presence:
    from .api.journal import append_rows

    if state.departure_owed is not None:
        await append_rows(db, incident_id, [_row(state.n, "away", p, state.departure_owed, label)])
    return replace(state, departure_owed=None)


#: what the flush of an Einsatz that stopped being active needs to write its owed rows
_last_seen: dict[tuple[str, int], tuple[VehiclePosition, str]] = {}


async def observe(db: AsyncSession, positions: list[VehiclePosition], now: datetime) -> int:
    """One tick: advance every vehicle at every active Einsatz, write what became true.
    Returns the number of records written (events + rows). The caller commits."""
    from .alarms import get_config_model

    written = 0
    active = await active_incidents(db, now)
    live = {str(i.id) for i in active}

    # An Einsatz that stopped being active (closed, archived, 24 h old) owes its vehicles'
    # last departures NOW — nobody will tick it again.
    for key in [k for k in _state if k[0] not in live]:
        st = _state.pop(key)
        seen = _last_seen.pop(key, None)
        if st is not None and seen is not None and departure_due(st, now, closing=True):
            try:
                await _flush_departure(db, uuid.UUID(key[0]), seen[0], st, seen[1])
                written += 1
            except Exception:  # noqa: BLE001 — a deleted incident has nothing left to owe
                logger.info("Owed departure for %s not written (incident gone)", key)
    if not active or not positions:
        return written

    fleet = (await get_config_model(db)).fleet.vehicles
    for inc in active:
        for p in positions:
            key = (str(inc.id), p.device_id)
            fix = p.last_update if p.last_update.tzinfo else p.last_update.replace(tzinfo=now.tzinfo)
            vehicle = fleet_vehicle_for(p, fleet)
            label = next((v.label for v in fleet if v.id == vehicle), None) or p.device_name
            _last_seen[key] = (p, label)
            if key not in _state:
                _state[key] = await _rebuild(db, inc.id, p.device_id)
            before = _state[key]
            res = step(before, haversine_m(inc.lat, inc.lng, p.latitude, p.longitude), fix, now)
            st = res.state
            if res.baseline and st is not None:
                await _record_event(db, inc.id, p, st, vehicle, fix)
                # a vehicle that has never been on scene has no line in this Einsatz's table —
                # every station vehicle starts as «away» from every open Einsatz
                if vehicle and st.fahrten:
                    await _store_blob(db, inc.id, vehicle, st, p.device_id)
                written += 1
            elif res.transition and st is not None:
                # the stamp is the FIRST fix in the new zone, not the fix that settled it
                stamp = before.pending_fix if before and before.pending_fix else fix
                await _record_event(db, inc.id, p, st, vehicle, stamp)
                written += 1
                arrival_ours = True
                if vehicle and st.fahrten:
                    arrival_ours = await _store_blob(db, inc.id, vehicle, st, p.device_id)
                # the FIRST arrival is a Verlauf row; every later one is a trip (D2-a) — unless
                # the external geofence already wrote «TLF vor Ort …» for this vehicle
                if res.transition == "scene" and st.first_arrival == stamp and arrival_ours:
                    from .api.journal import append_rows

                    await append_rows(db, inc.id, [_row(st.n, "scene", p, stamp, label)])
                    written += 1
            if st is not None and departure_due(st, now):
                st = await _flush_departure(db, inc.id, p, st, label)
                written += 1
            _state[key] = st
    return written
