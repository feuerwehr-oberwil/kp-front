"""Validate alarm-bearing fields on writes without restricting unrelated workspace data."""

import math
from datetime import datetime
from typing import TypeGuard


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


def _timestamps(record: dict, keys: tuple[str, ...]) -> None:
    for key in keys:
        value = record.get(key)
        if value is not None and value != "" and timestamp_ms(value) is None:
            raise ValueError(f"{key}: gültiger Zeitstempel erforderlich")


def validate_trupp(trupp: object) -> None:
    if not isinstance(trupp, dict):
        raise ValueError("Trupp muss ein Objekt sein")
    _timestamps(trupp, ("entryTime", "lastContactTime", "lastPressureTime", "exitTime"))
    for key in ("entryPressureBar", "lastPressureBar"):
        value = trupp.get(key)
        if value is not None and not finite_nonnegative(value):
            raise ValueError(f"{key}: nichtnegative Zahl erforderlich")
    for key in ("id", "name", "kind", "status"):
        value = trupp.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{key}: Text erforderlich")


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


def validate_alarm_workspace(workspace: dict) -> None:
    for key, validator in (("trupps", validate_trupp), ("timeline", validate_reminder_row)):
        rows = workspace.get(key)
        if rows is not None:
            if not isinstance(rows, list):
                raise ValueError(f"{key}: Liste erforderlich")
            for row in rows:
                validator(row)
    settings = workspace.get("settings")
    if settings is not None:
        if not isinstance(settings, dict):
            raise ValueError("Workspace-Einstellungen müssen ein Objekt sein")
        for key in ("contactIntervalMin", "contactGraceSec"):
            value = settings.get(key)
            if value is not None and not finite_nonnegative(value):
                raise ValueError(f"{key}: nichtnegative Zahl erforderlich")
