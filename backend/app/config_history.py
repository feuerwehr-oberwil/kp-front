"""Keeping the config document that is about to be replaced — the one undo for a bad write.

⚠️ ``deployment_config.config_json`` has NO partial writes. The Verwaltung, ``admin_config load``,
the geodata push, the backup import and the branding endpoints each replace the whole document, so
a single writer holding an outdated copy silently costs a station its Dienstgrade, its Atemschutz-
Doktrin (the Alarmdruck included), its Partnerorganisationen and its Fahrzeuge. The public demo
lost its config three times in four days: each occurrence came through a different path, each was
diagnosed only after somebody noticed a missing logo, and each fix closed the path that had just
been observed while the next one came through another.

The guards in front of those paths are worth having and are still there. This module is the layer
that does not depend on having enumerated them: **before any write, the outgoing document is
kept.** It protects nothing and covers everything.

⚠️ It matters most where it will hopefully never be needed. The demo could be repaired by
re-running its reset — a real station has no seed file to rebuild from, so for Oberwil a stale
``admin_config load`` would have been unrecoverable. Restoring is ``admin_config restore``.

Failure here must NEVER block the write: a station that cannot save its config because the safety
net is broken is worse off than one without the net. Every call site treats it as best-effort.
"""

import logging
import uuid
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import DeploymentConfig, DeploymentConfigHistory

logger = logging.getLogger(__name__)

#: Which path is doing the replacing. Recorded because after the fact nobody could say whether a
#: clobbered config had come from a browser tab or from a terminal — and the answer decides which
#: guard was missing.
Source = Literal["api", "cli", "branding", "geodata", "roster", "workbook"]


async def keep_previous(db: AsyncSession, source: Source, actor_id: uuid.UUID | None = None) -> None:
    """Store the CURRENT config document before the caller overwrites it.

    Call immediately before assigning a new ``config_json``, in the same session/transaction, so
    the keep and the write land together or not at all.

    A no-op when there is nothing to keep (a fresh install, or a row whose document is empty):
    there is no earlier state to return to, and a row of ``null`` would only add noise to
    ``admin_config history``.
    """
    try:
        row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        if row is None or not row.config_json:
            return
        db.add(
            DeploymentConfigHistory(
                config_json=row.config_json,
                source=source,
                replaced_by=actor_id,
            )
        )
    except Exception:  # the net must never be the thing that drops the write
        logger.exception("Could not keep the previous deployment config (continuing with the write)")


def emptied_sections(old: dict[str, Any] | None, new: dict[str, Any]) -> list[str]:
    """Which populated parts of `old` would be left EMPTY by `new` — the shape of every one of
    these incidents.

    Not a diff. A diff of a clobbered config is hundreds of lines and reads as noise; what makes
    the damage recognisable is narrower and always the same: sections that HAD content and now
    have none. «roster.ranks: 4 → 0», «doctrine.alarmBar: 100 → nothing». A value merely CHANGING
    is ordinary editing and is not reported.

    Walks one level into the top-level sections, which is where the config's meaning lives
    (`roster.ranks`, `doctrine.alarmBar`, `report.partnerOrgs`, `fleet.vehicles`,
    `alarms.groups`). Deeper than that a "section" is a single field and the noise returns.
    """
    if not old:
        return []
    out: list[str] = []

    def empty(v: Any) -> bool:
        # 0 and False are values somebody chose; None and the empty containers are absence.
        return v is None or (isinstance(v, list | dict | str) and len(v) == 0)

    for key, old_val in old.items():
        new_val = new.get(key)
        if isinstance(old_val, dict) and isinstance(new_val, dict):
            for sub, old_sub in old_val.items():
                if not empty(old_sub) and empty(new_val.get(sub)):
                    out.append(f"{key}.{sub}")
        elif not empty(old_val) and empty(new_val):
            out.append(key)
    return out


def changed_sections(old: dict[str, Any] | None, new: dict[str, Any] | None) -> list[str]:
    """Which parts of the config a write actually TOUCHED — «fleet.vehicles», «map.defaultView».

    ⚠️ The obvious thing to list about a kept document — which sections it CONTAINS — turned out
    to be worthless: every writer replaces the whole document, so every row of «Letzte Änderungen»
    read «alarms, doctrine, fleet, identity, journal, map, mittel, report, roster», 26 times in a
    row after one afternoon of setup. A list whose rows cannot be told apart cannot answer the one
    question it is read for: *which* entry do I go back to?

    So compare the kept document against the one that replaced it (its successor in the table, or
    the live document for the newest entry) and name what differs. Same depth as
    :func:`emptied_sections` — one level into the top-level sections, where the config's meaning
    lives; deeper than that a "section" is a single field and the noise returns.

    An empty list is meaningful and not an error: the write stored a document byte-identical to
    the one before it, which is what an autosave firing on a re-render looks like.
    """
    old = old or {}
    new = new or {}
    out: list[str] = []
    for key in sorted(set(old) | set(new)):
        old_val, new_val = old.get(key), new.get(key)
        if old_val == new_val:
            continue
        # A section that appeared or vanished entirely still names the parts of it that moved:
        # «report.partnerOrgs», not a bare «report» that says nothing about what was in it.
        if isinstance(old_val, dict | None) and isinstance(new_val, dict | None):
            o, n = old_val or {}, new_val or {}
            subs = sorted(set(o) | set(n))
            out.extend(f"{key}.{sub}" for sub in subs if o.get(sub) != n.get(sub))
        else:
            out.append(key)
    return out
