"""Validate alarm-bearing fields on writes without restricting unrelated workspace data."""

import json
import math
from collections import Counter
from datetime import datetime
from typing import Literal, TypeGuard, get_args

#: A Trupp's lifecycle phase — the ONE list of its words (client twin: src/types.ts · Trupp.status,
#: held equal to the enum this emits into docs/openapi.json by src/lib/truppStatus.test.ts).
#: angemeldet → aktiv → rueckzug → raus by hand; `ueberfaellig` is the derived overlay.
#: Lives here, not in schemas, because `validate_trupp` refuses any other word on a new write.
TruppStatus = Literal["angemeldet", "aktiv", "rueckzug", "ueberfaellig", "raus"]
#: src/types.ts · TruppKind. Absent means `atemschutz`; only `einfach` has no contact clock.
TruppKind = Literal["atemschutz", "einfach"]

#: The Atemschutz contact clock's station range (owner, 26.10.2026): the Funkkontakt-Intervall in
#: minutes and the Nachfrist in seconds. ONE rule for the /admin doctrine (schemas ·
#: DoctrineConfig), a per-Einsatz override (below) and the push sweep's fallback (push ·
#: due_trupps); the client twin is src/lib/workspace.ts · CONTACT_BOUNDS. Before it, 0 and 1e308
#: both passed: 1e308 never alarms, and 0 alarmed at once on the push path while the board fell
#: back to the doctrine (audit F02, 25.10.2026).
CONTACT_INTERVAL_MIN = (1, 30)
CONTACT_GRACE_SEC = (0, 300)


def timestamp_ms(value: object) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except (ValueError, OverflowError, OSError):
        return None


def finite_nonnegative(value: object) -> TypeGuard[int | float]:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def in_range(value: object, bounds: tuple[int, int]) -> TypeGuard[int | float]:
    return finite_nonnegative(value) and bounds[0] <= value <= bounds[1]


def _string_list(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(x, str) for x in value)


def _timestamps(record: dict, keys: tuple[str, ...]) -> None:
    for key in keys:
        value = record.get(key)
        if value is not None and value != "" and timestamp_ms(value) is None:
            raise ValueError(f"{key}: gültiger Zeitstempel erforderlich")


def validate_trupp(trupp: object) -> None:
    if not isinstance(trupp, dict):
        raise ValueError("Trupp muss ein Objekt sein")
    # ``notfallAt`` — the Atemschutznotfall's trigger (F1, 08.10.2026): the push sweep keys its
    # crossing on it, so it is a timestamp or nothing, like the contact clock it outranks
    _timestamps(trupp, ("entryTime", "lastContactTime", "lastPressureTime", "exitTime", "notfallAt"))
    for key in ("entryPressureBar", "lastPressureBar"):
        value = trupp.get(key)
        if value is not None and not finite_nonnegative(value):
            raise ValueError(f"{key}: nichtnegative Zahl erforderlich")
    for key in ("id", "name", "kind", "status"):
        value = trupp.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{key}: Text erforderlich")
    # the Trupp's number («Trupp 3», docs/trupp-naming.md) — a counter, so a whole non-negative
    # number or nothing; absent on records written before 12.09.
    no = trupp.get("no")
    if no is not None and (isinstance(no, bool) or not isinstance(no, int) or no < 0):
        raise ValueError("no: nichtnegative ganze Zahl erforderlich")
    # The discriminators decide whether the contact clock runs at all: a typo («atemschut») used
    # to be stored and read as «not under PA» on the board and here (audit F01, 25.10.2026). Both
    # readers now treat anything but `einfach` as monitored; a new word is refused outright.
    if trupp.get("kind") is not None and trupp["kind"] not in get_args(TruppKind):
        raise ValueError("kind: atemschutz oder einfach erforderlich")
    if trupp.get("status") is not None and trupp["status"] not in get_args(TruppStatus):
        raise ValueError(f"status: eines von {', '.join(get_args(TruppStatus))} erforderlich")
    # The crew lists every label and lookup reads (lib/atemschutz · truppLogName trims each
    # member): a `null` in there was stored and then threw on every device (audit F03).
    for key in ("members", "memberPersonIds", "equipment"):
        value = trupp.get(key)
        if value is not None and not _string_list(value):
            raise ValueError(f"{key}: Liste von Texten erforderlich")
    if trupp.get("leaderPersonId") is not None and not isinstance(trupp["leaderPersonId"], str):
        raise ValueError("leaderPersonId: Text erforderlich")
    readings = trupp.get("readings")
    if readings is not None and not (isinstance(readings, list) and all(isinstance(r, dict) for r in readings)):
        raise ValueError("readings: Liste von Objekten erforderlich")


def validate_reminder_row(row: object) -> None:
    if not isinstance(row, dict):
        raise ValueError("Journalzeile muss ein Objekt sein")
    reminder = row.get("reminder")
    if reminder is None:
        return
    if not isinstance(reminder, dict):
        raise ValueError("Wiedervorlage muss ein Objekt sein")
    for key in ("id", "op"):
        if not isinstance(reminder.get(key), str) or not reminder[key]:
            raise ValueError(f"Wiedervorlage {key}: Text erforderlich")
    _timestamps(reminder, ("dueAt",))


def _encoded(value: object) -> str:
    """JSON identity ignores object-key order but distinguishes booleans from numbers."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _no_new_duplicate_ids(rows: object, old_rows: object) -> None:
    """Refuse a save that adds a second Trupp under an id already in the list.

    Every client merges Trupps by id (src/lib/mergeWorkspace · mergeById), so two rows sharing
    one collapse into one at the next merge — a whole crew gone (audit F04, 25.10.2026). A
    duplicate already stored is tolerated as often as it was stored, like any legacy row; the
    client splits it at load (src/lib/workspace · sanitizeWorkspace).
    """
    if not isinstance(rows, list):
        return
    ids = Counter(r["id"] for r in rows if isinstance(r, dict) and isinstance(r.get("id"), str))
    old = Counter(
        r["id"]
        for r in (old_rows if isinstance(old_rows, list) else [])
        if isinstance(r, dict) and isinstance(r.get("id"), str)
    )
    for tid, n in ids.items():
        if n > max(1, old[tid]):
            raise ValueError(f"Trupp-id doppelt: {tid}")


# The only workspace keys `validate_alarm_workspace` reads — the save path copies just these of
# the stored blob as `previous` (incident_service · apply_workspace_put). Read a new key ⇒ add it.
ALARM_VALIDATED_KEYS = ("trupps", "timeline", "settings")


def validate_alarm_workspace(workspace: dict, previous: dict | None = None) -> None:
    """Reject new invalid alarm values; preserve exact, counted legacy rows already stored."""
    previous = previous or {}
    _no_new_duplicate_ids(workspace.get("trupps"), previous.get("trupps"))
    for key, validator in (("trupps", validate_trupp), ("timeline", validate_reminder_row)):
        rows = workspace.get(key)
        if rows is not None:
            if not isinstance(rows, list):
                if _encoded(rows) == _encoded(previous.get(key)):
                    continue
                raise ValueError(f"{key}: Liste erforderlich")
            old_rows = previous.get(key)
            retained: Counter[str] | None = None
            for row in rows:
                try:
                    validator(row)
                except ValueError:
                    if retained is None:
                        retained = (
                            Counter(_encoded(old) for old in old_rows) if isinstance(old_rows, list) else Counter()
                        )
                    identity = _encoded(row)
                    if not retained[identity]:
                        raise
                    retained[identity] -= 1
    settings = workspace.get("settings")
    old_settings = previous.get("settings")
    if settings is not None:
        if not isinstance(settings, dict):
            if _encoded(settings) == _encoded(old_settings):
                return
            raise ValueError("Workspace-Einstellungen müssen ein Objekt sein")
        for key, bounds in (("contactIntervalMin", CONTACT_INTERVAL_MIN), ("contactGraceSec", CONTACT_GRACE_SEC)):
            value = settings.get(key)
            if value is not None and not in_range(value, bounds):
                if isinstance(old_settings, dict) and _encoded(value) == _encoded(old_settings.get(key)):
                    continue
                raise ValueError(f"{key}: Zahl von {bounds[0]} bis {bounds[1]} erforderlich")
