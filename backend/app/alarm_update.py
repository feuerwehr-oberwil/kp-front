"""«Alarm aktualisiert»: a follow-up of the alarm an open Einsatz was opened from.

The Leitstelle may send a second SMS for the same incident; upstream merges it into the same
Divera alarm, which then arrives again with a later ``ts_update`` and a changed title, text or
address. Nothing here overwrites the Einsatz on its own (owner, 15.11.2026): the update is kept
as ONE pending record on the incident (``Incident.alarm_update_json``), every device shows it as
a Meldeleiste row, and the crew decides – take it, edit it, or hide it (and show it again).

The stored record, one JSON object::

    state      "pending" | "taken" | "hidden" | "same" (said nothing new) – "pending" and
               "hidden" are served (models · Incident.alarm_update): a hidden one stands on every
               device as a grey strip with «Zeigen» (`show`, rare-user round F7, 17.11.2026)
    at         ISO time the update arrived
    ts_update  the alarm's ts_update – a poll that sees the same one again does nothing
    alarm      the alarm's values: title, text, address, lat, lng
    fields     [{field, current, alarm, edited}] – what differs from the Einsatz right now;
               `edited` = the crew changed that field by hand (a `meta.change` from the
               Einsatzdaten panel), so «Übernehmen» leaves it alone
    before     after an accept: the values it overwrote, for «Rückgängig»

A later update replaces the record whatever its state (the row shows the latest alarm against
the Einsatz as it stands); one identical to what the Einsatz already has stores nothing.
`refresh` recomputes `fields` after every change of the Einsatzdaten, so the row and the
«Übernehmen» label never go stale. Accept, hide, show and undo write the Verlauf row server-side,
so every device and the Rapport see the same decision.

Only Divera has this path: the generic intake (api/alarms) and FireHub drop a repeated
delivery of a known alarm, and carry no update stamp to tell a follow-up from a retry.
"""

from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import audit
from .geocode import geocode
from .models import Incident, IncidentEvent
from .schemas import DiveraWebhookPayload

AlarmField = Literal["title", "address", "text"]
#: the order the row and the Verlauf name them in
FIELDS: tuple[AlarmField, ...] = ("address", "title", "text")
#: what the Verlauf calls each field
LABELS: dict[str, str] = {"address": "Adresse", "title": "Stichwort", "text": "Meldung"}
#: the Einsatzdaten columns a hand edit of each field shows up as (meta.change payload keys)
_EDIT_KEYS: dict[str, tuple[str, ...]] = {"address": ("address", "lat", "lng"), "title": ("title",), "text": ("text",)}
#: the audit source of this module's own writes – NOT a hand edit (see `hand_edited`)
SOURCE = "alarm_update"


def _norm(v: Any) -> str:
    return " ".join(str(v or "").split())


def _coord(lat: Any, lng: Any) -> tuple[float, float] | None:
    """A usable (lat, lng) pair, or None – 0/0 is Divera's «no location»."""
    if lat is None or lng is None:
        return None
    la, ln = float(lat), float(lng)
    return None if abs(la) < 1e-6 and abs(ln) < 1e-6 else (la, ln)


def is_own_alarm(inc: Incident, divera_id: int) -> bool:
    """The Einsatz was opened FROM this alarm – an attached Nachalarm is not its own."""
    return inc.source == "divera" and inc.source_ref == str(divera_id)


def changed_fields(inc: Incident, alarm: dict[str, Any]) -> list[str]:
    """The fields whose alarm value differs from the Einsatz's (whitespace-insensitive).
    An alarm without a title says nothing about the title."""
    return [
        f for f in FIELDS if (f != "title" or _norm(alarm.get(f))) and _norm(alarm.get(f)) != _norm(getattr(inc, f))
    ]


async def hand_edited(db: AsyncSession, incident_id: Any) -> set[str]:
    """The fields whose LATEST change was by hand in the Einsatzdaten panel.

    Read from the audit chain: `patch_incident` writes `meta.change` (source «einsatzdaten»)
    with the changed columns; this module's own writes (accept, undo, a value taken in the form)
    carry SOURCE. The last of them per field decides – once the crew takes the alarm's value
    after typing their own, the next follow-up of that field is taken normally again."""
    rows = (
        await db.execute(
            select(IncidentEvent.source, IncidentEvent.payload_json)
            .where(
                IncidentEvent.incident_id == incident_id,
                IncidentEvent.op_type == "meta.change",
                IncidentEvent.source.in_(("einsatzdaten", SOURCE)),
            )
            .order_by(IncidentEvent.seq)
        )
    ).all()
    edited: set[str] = set()
    for source, p in rows:
        if not (isinstance(p, dict) and isinstance(p.get("fields"), dict)):
            continue
        touched = {f for f, cols in _EDIT_KEYS.items() if p["fields"].keys() & set(cols)}
        edited = edited | touched if source == "einsatzdaten" else edited - touched
    return edited


def taken_in_form(inc: Incident, changed: dict[str, Any]) -> set[str]:
    """The columns of an Einsatzdaten save (`changed`, the meta.change payload, already applied
    to `inc`) that put the pending alarm's value in place – «Bearbeiten» → «Übernehmen» beside a
    field, then «Speichern». The caller records those under this module's SOURCE, not as a hand
    edit: the crew agreed with the alarm, so the next follow-up of that field is not «von euch».
    A taken address brings its pin along (lat/lng of the same save)."""
    rec = inc.alarm_update_json
    if not isinstance(rec, dict) or rec.get("state") != "pending":
        return set()
    alarm = rec["alarm"]
    cols: set[str] = {
        f for f in FIELDS if f in changed and _norm(alarm.get(f)) and _norm(alarm.get(f)) == _norm(getattr(inc, f))
    }
    if "address" in cols:
        cols |= {"lat", "lng"} & changed.keys()
    return cols


def _added(old: str, new: str) -> str | None:
    """What a new text appends to the old one («ergänzt»), or None if it is not an append."""
    if old and new.startswith(old) and len(new) > len(old):
        return new[len(old) :].strip(" ,;.–-") or None
    return None


def describe(fields: list[dict[str, Any]]) -> str:
    """«Adresse A → B, Meldung ergänzt «…»» – the arrival's Verlauf sentence."""
    parts = []
    for f in fields:
        cur, new = _norm(f["current"]), _norm(f["alarm"])
        if f["field"] == "text":
            add = _added(cur, new)
            parts.append(f"Meldung ergänzt «{add}»" if add else f"Meldung neu «{new}»")
        else:
            parts.append(f"{LABELS[f['field']]} {cur or '–'} → {new or '–'}")
    return ", ".join(parts)


async def refresh(db: AsyncSession, inc: Incident) -> list[str]:
    """Recompute a PENDING record's `fields` against the Einsatz as it stands now.

    Returns the fields that were pending before and now match the alarm – the crew took them by
    hand («Bearbeiten»). When nothing is left, the record is closed as taken. No-op unless a
    record is pending."""
    rec = inc.alarm_update_json
    if not isinstance(rec, dict) or rec.get("state") != "pending":
        return []
    alarm = rec["alarm"]
    edited = await hand_edited(db, inc.id)
    now = changed_fields(inc, alarm)
    was = [f["field"] for f in rec.get("fields", [])]
    fields = [{"field": f, "current": getattr(inc, f), "alarm": alarm.get(f), "edited": f in edited} for f in now]
    inc.alarm_update_json = {**rec, "fields": fields, "state": "pending" if fields else "taken"}
    return [f for f in was if f not in now]


async def after_edit(db: AsyncSession, inc: Incident) -> None:
    """After a save of the Einsatzdaten: re-diff the pending update, and once the crew has taken
    every field through «Bearbeiten», close it with its Verlauf row like an accept."""
    resolved = await refresh(db, inc)
    rec = inc.alarm_update_json
    if resolved and isinstance(rec, dict) and rec.get("state") == "taken":
        names = ", ".join(LABELS[f] for f in resolved)
        await _verlauf(db, inc, f"Alarm-Aktualisierung übernommen: {names} (über Einsatzdaten)")


async def record(db: AsyncSession, inc: Incident, payload: DiveraWebhookPayload) -> None:
    """Keep a Divera update of the Einsatz's own alarm as its pending «Alarm aktualisiert».

    Idempotent per ``ts_update``: the poll sees an advanced stamp on every round once the pool
    row stops mirroring (divera · upsert_emergency), and must not write the Verlauf each time."""
    rec = inc.alarm_update_json if isinstance(inc.alarm_update_json, dict) else None
    if rec and (rec.get("ts_update") or 0) >= (payload.ts_update or 0):
        return
    alarm = {
        "title": payload.title or None,
        "text": payload.text or None,
        "address": payload.address or None,
        "lat": payload.lat,
        "lng": payload.lng,
    }
    if not changed_fields(inc, alarm):
        # nothing new for the Einsatz – a pending older update is superseded by this one, and
        # the stamp stays: a hand edit made later must not turn this same update into a row
        inc.alarm_update_json = {"state": "same", "ts_update": payload.ts_update}
        return
    inc.alarm_update_json = {
        "state": "pending",
        "at": datetime.now(UTC).isoformat(),
        "ts_update": payload.ts_update,
        "alarm": alarm,
        "fields": [],
    }
    await refresh(db, inc)
    await _verlauf(db, inc, f"Alarm aktualisiert: {describe(inc.alarm_update_json['fields'])}")
    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="divera.update",
        source="divera",
        payload={"divera_id": payload.id, "alarm_update": "pending", "ts_update": payload.ts_update},
    )


async def accept(db: AsyncSession, inc: Incident, only: list[AlarmField] | None, user_id: Any) -> list[str]:
    """Take the pending update into the Einsatz. Returns the fields taken (may be empty).

    Without `only`: every changed field nobody edited by hand. With it: exactly those (an
    explicit choice outranks a hand edit). Taking the address moves the pin – the alarm's own
    coordinate, else the address geocoded, else no pin (as the open path does). A new title is
    title text only: Einsatzart and priority stay what they are."""
    await refresh(db, inc)
    rec = inc.alarm_update_json
    if not isinstance(rec, dict) or rec.get("state") != "pending":
        return []
    pending = rec["fields"]
    take = [f["field"] for f in pending if (f["field"] in only if only is not None else not f["edited"])]
    if not take:
        return []
    alarm = rec["alarm"]
    before: dict[str, Any] = {}
    for f in take:
        before[f] = getattr(inc, f)
        setattr(inc, f, alarm.get(f))
    if "address" in take:
        before["lat"], before["lng"] = _float(inc.lat), _float(inc.lng)
        coord = _coord(alarm.get("lat"), alarm.get("lng"))
        if coord is None and inc.address:
            coord = await geocode(inc.address)
        inc.lat, inc.lng = coord if coord else (None, None)
    changed = {
        k: {"from": v, "to": _float(getattr(inc, k)) if k in ("lat", "lng") else getattr(inc, k)}
        for k, v in before.items()
    }
    await audit.append_event(
        db, incident_id=inc.id, op_type="meta.change", source=SOURCE, user_id=user_id, payload={"fields": changed}
    )
    left = [LABELS[f["field"]] for f in pending if f["field"] not in take]
    text = f"Alarm-Aktualisierung übernommen: {', '.join(LABELS[f] for f in take)}"
    if left:
        text += f" ({', '.join(left)} bleibt)"
    await _verlauf(db, inc, text)
    inc.alarm_update_json = {**rec, "state": "taken", "before": before, "fields": []}
    return take


async def dismiss(db: AsyncSession, inc: Incident, user_id: Any) -> bool:
    """Hide the pending update for every device of the Einsatz. False when none is pending."""
    rec = inc.alarm_update_json
    if not isinstance(rec, dict) or rec.get("state") != "pending":
        return False
    inc.alarm_update_json = {**rec, "state": "hidden"}
    await _verlauf(db, inc, "Alarm-Aktualisierung ausgeblendet")
    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="divera.update",
        source=SOURCE,
        user_id=user_id,
        payload={"alarm_update": "hidden"},
    )
    return True


async def show(db: AsyncSession, inc: Incident, user_id: Any) -> bool:
    """«Zeigen» on the strip a hide left: the update pending again for every device, re-diffed
    against the Einsatz as it stands now (a hand edit made meanwhile counts). False when none is
    hidden."""
    rec = inc.alarm_update_json
    if not isinstance(rec, dict) or rec.get("state") != "hidden":
        return False
    inc.alarm_update_json = {**rec, "state": "pending"}
    await refresh(db, inc)
    await _verlauf(db, inc, "Alarm-Aktualisierung wieder eingeblendet")
    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="divera.update",
        source=SOURCE,
        user_id=user_id,
        payload={"alarm_update": "pending"},
    )
    return True


async def undo(db: AsyncSession, inc: Incident, user_id: Any) -> bool:
    """«Rückgängig» after an accept: the overwritten values back, the update pending again."""
    rec = inc.alarm_update_json
    if not isinstance(rec, dict) or rec.get("state") != "taken" or not rec.get("before"):
        return False
    before = rec["before"]
    changed = {
        k: {"from": _float(getattr(inc, k)) if k in ("lat", "lng") else getattr(inc, k), "to": v}
        for k, v in before.items()
    }
    for k, v in before.items():
        setattr(inc, k, v)
    inc.alarm_update_json = {k: v for k, v in rec.items() if k != "before"} | {"state": "pending"}
    await refresh(db, inc)
    await audit.append_event(
        db, incident_id=inc.id, op_type="meta.change", source=SOURCE, user_id=user_id, payload={"fields": changed}
    )
    await _verlauf(db, inc, "Übernahme der Alarm-Aktualisierung rückgängig gemacht")
    return True


def _float(v: Any) -> float | None:
    return None if v is None else float(v)


async def _verlauf(db: AsyncSession, inc: Incident, text: str) -> None:
    """One Verlauf row about the Einsatz's alarm update. They share a subject, so the Rapport's
    repeat fold never prints «übernommen» → «rückgängig» → «übernommen» as «übernommen 2×»."""
    from .api.journal import append_system_row  # lazy – the api package imports the services

    await append_system_row(db, inc.id, icon="bell", text=text, subject=SOURCE)
