"""Roster snapshot → this deployment's ``personnel``: KP Front's half of the ingestion.

A station whose personnel list lives somewhere else (an HR system, a spreadsheet export, a
sibling application such as fwo-admin) publishes it as a ``roster-snapshot/1`` file
(docs/CONFIGURATION.md §4c), and this module reads it — polled every
``roster.snapshotIntervalMin`` minutes and on demand («Jetzt abrufen» on System ›
Verbindungen, ``POST /api/personnel/snapshot/sync``).

**Off unless a source is set.** Nothing happens until the ``station_index_source`` credential
(the station index, app/station_index.py — owner decision X6/X7: one address for all station
data) or the older ``roster_snapshot_source`` holds an address or a path (``/admin ›
Anbindungen``, or ``STATION_INDEX_SOURCE`` / ``ROSTER_SNAPSHOT_SOURCE`` in ``.env``). The index
wins when it lists a roster; the direct source is the fallback (:func:`fetch_roster`). Divera and the CSV import are untouched by this module and stay the default —
a station can run both, in which case each writes what it carries and the later run wins a
name (documented in §4c; most stations will run one).

**The rules live in the shared half.** Matching, the deactivation cap, the never-empty and
time-travel guards and the outcome report are :mod:`app.roster_snapshot_ingest`, byte-identical
with KP Rück's copy, so one published file lands the same way in both products. What is KP
Front's own is here and nothing else: where the source is configured, how a ``Personnel`` row
is written, and that the last report is kept in ``connector_states`` (row
``roster_snapshot``), served on ``GET /api/system``.

Read-only towards the source, additive towards the roster: rows are created, renamed, re-ranked,
deactivated and re-activated, never deleted, and an existing identity link is never rewritten.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import connector_state, station_index
from .credentials import get as credential
from .credentials import load as load_credentials
from .models import ConnectorState, DeploymentConfig, Incident, Personnel, PersonnelExternalIdentity
from .personnel import attach_external_identity, load_roster_ranks
from .roster_snapshot_ingest import (
    DEFAULT_INTERVAL_MIN,
    DEFAULT_MAX_DEACTIVATE_PCT,
    LastGood,
    LocalPerson,
    Reconciliation,
    reconcile,
    refused_outcome,
    status_json,
)

logger = logging.getLogger(__name__)

#: How often the scheduler LOOKS (it runs only when the configured interval has passed). Short,
#: so a source set in the browser is read within minutes and an interval change applies at once.
TICK_SECONDS = 300


def configured() -> bool:
    """Is a roster source set — the station index, or the direct roster file (the fallback)?
    Synchronous, like every credential reader (load first)."""
    return bool(credential("station_index_source") or credential("roster_snapshot_source"))


async def fetch_roster(
    *, transport: httpx.AsyncBaseTransport | None = None
) -> tuple[bytes, Literal["index", "direct"], dict[str, Any] | None]:
    """The roster bytes and how they were found — through the station index (``station_index_
    source``), or the direct ``roster_snapshot_source`` as the fallback. The rule is the shared
    :func:`station_index.read_via_index`, the same in KP Rück."""
    return await station_index.read_via_index(
        "roster",
        index_source=credential("station_index_source") or None,
        index_token=credential("station_index_token") or None,
        direct_source=credential("roster_snapshot_source") or None,
        direct_token=credential("roster_snapshot_token") or None,
        transport=transport,
    )


async def roster_policy(db: AsyncSession) -> tuple[int, int]:
    """``(interval minutes, max deactivation %)`` from ``roster.*`` (stored config → shipped)."""
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    roster = ((row.config_json or {}).get("roster") or {}) if row else {}
    interval = roster.get("snapshotIntervalMin")
    pct = roster.get("snapshotMaxDeactivatePct")
    return (
        interval if isinstance(interval, int) and 5 <= interval <= 1440 else DEFAULT_INTERVAL_MIN,
        pct if isinstance(pct, int) and 0 <= pct <= 100 else DEFAULT_MAX_DEACTIVATE_PCT,
    )


async def _row(db: AsyncSession) -> ConnectorState | None:
    return (
        await db.execute(select(ConnectorState).where(ConnectorState.name == connector_state.ROSTER_SNAPSHOT))
    ).scalar_one_or_none()


async def load_people(db: AsyncSession) -> tuple[list[LocalPerson], dict[str, Personnel]]:
    """Every person, oldest first, with every identity — plus the rows by id for the write.

    The deprecated ``personnel.divera_id`` column counts as a ``divera`` identity where no row
    exists yet (the migration window ``personnel.provider_people`` also honours), so a station
    whose people still carry only the column is not told they are strangers."""
    rows = list((await db.execute(select(Personnel).order_by(Personnel.created_at, Personnel.id))).scalars())
    idents: dict[uuid.UUID, dict[str, str]] = {}
    for ident in (await db.execute(select(PersonnelExternalIdentity))).scalars():
        idents.setdefault(ident.personnel_id, {})[ident.provider] = ident.external_id
    people: list[LocalPerson] = []
    for row in rows:
        ids = dict(idents.get(row.id, {}))
        if "divera" not in ids and row.divera_id is not None:
            ids["divera"] = str(row.divera_id)
        people.append(
            LocalPerson(
                id=str(row.id),
                display_name=row.display_name,
                first_name=row.first_name,
                last_name=row.last_name,
                rank=row.rank,
                active=row.is_active,
                identities=ids,
            )
        )
    return people, {str(r.id): r for r in rows}


async def apply(db: AsyncSession, rec: Reconciliation, rows: dict[str, Personnel]) -> None:
    """Write one accepted plan. Flushes, never commits — the caller owns the transaction."""
    if rec.snapshot is None or rec.refused is not None:
        raise ValueError("a refused plan is never applied")
    for write in rec.creates:
        person = Personnel(
            display_name=write.fields["display_name"] or write.display_name,
            first_name=write.fields.get("first_name"),
            last_name=write.fields.get("last_name"),
            rank=write.fields.get("rank"),
            is_active=True,
        )
        db.add(person)
        await db.flush()
        for provider, external_id in write.links:
            await attach_external_identity(db, person=person, provider=provider, external_id=external_id)
    for write in rec.updates:
        person = rows[str(write.person_id)]
        for name, value in write.fields.items():
            setattr(person, name, value)
        if write.reactivate:
            person.is_active = True
        for provider, external_id in write.links:
            await attach_external_identity(db, person=person, provider=provider, external_id=external_id)
    for gone in rec.deactivations:
        rows[gone.person_id].is_active = False
    await db.flush()


async def run(
    db: AsyncSession,
    *,
    trigger: str,
    force: bool = False,
    skip_unchanged: bool = False,
) -> dict[str, Any]:
    """Fetch, reconcile, apply, record. Returns the status document (also stored).

    Commits on every path: the applied roster together with its report, or — when anything went
    wrong — nothing but the report. ⚠️ Rolled back BEFORE the failure is recorded, so a half
    -applied plan can never ride out on the back of its own error line.
    """
    await load_credentials(db)
    if not configured():
        raise ValueError("no roster source configured")
    _interval, max_pct = await roster_policy(db)
    row = await _row(db)
    previous: dict[str, Any] = dict(row.detail or {}) if row else {}
    last_good = LastGood.from_json(previous.get("lastGood"))

    try:
        raw, via, index_summary = await fetch_roster()
    except ValueError as e:
        await db.rollback()
        status = {
            **previous,
            "trigger": trigger,
            "outcome": refused_outcome(str(e), last_good=last_good).model_dump(mode="json", by_alias=True),
            "held": False,
            "unchanged": False,
            "pendingDeactivations": 0,
        }
        await connector_state.record(db, connector_state.ROSTER_SNAPSHOT, ok=False, error=str(e)[:400], detail=status)
        await db.commit()
        return status

    try:
        people, rows = await load_people(db)
        ranks = await load_roster_ranks(db)
        rec = reconcile(
            raw,
            people,
            known_ranks=[r["key"] for r in ranks if r.get("key")],
            max_deactivate_pct=max_pct,
            last_good=last_good,
            force=force,
            # A run that postponed somebody must look again even when the file has not moved —
            # the person it waited for may be free now.
            skip_unchanged=skip_unchanged and not previous.get("postponed"),
            now=datetime.now(UTC),
            busy_ids=await busy_person_ids(db, [p.id for p in people]),
            keep_names_for=names_owned_elsewhere(),
        )
        applied_at = previous.get("appliedAt")
        if rec.refused is None and not rec.unchanged:
            await apply(db, rec, rows)
            applied_at = datetime.now(UTC).isoformat()
        status = {
            **status_json(rec, trigger=trigger, last_good=last_good, applied_at=applied_at),
            "via": via,
            "index": index_summary,
        }
        await connector_state.record(
            db,
            connector_state.ROSTER_SNAPSHOT,
            ok=rec.refused is None,
            error=rec.refused[:400] if rec.refused else None,
            detail=status,
        )
        await db.commit()
    except Exception as e:
        # ⚠️ Rolled back FIRST, then reported like a refused file: nothing was written, the last
        # good snapshot stands, and the card says why — a run that crashes must not look like
        # one that never happened (or like the previous success).
        await db.rollback()
        logger.exception("Roster snapshot run failed")
        error = connector_state.safe_error(e)
        status = {
            **previous,
            "trigger": trigger,
            "outcome": refused_outcome(f"run failed: {error}", last_good=last_good).model_dump(
                mode="json", by_alias=True
            ),
            "held": False,
            "unchanged": False,
            "pendingDeactivations": 0,
        }
        await connector_state.record(db, connector_state.ROSTER_SNAPSHOT, ok=False, error=error, detail=status)
        await db.commit()
        return status
    outcome = rec.outcome
    logger.info(
        "Roster snapshot (%s): %s — +%d created, %d updated, %d deactivated, %d unmatched",
        trigger,
        "refused: " + rec.refused if rec.refused else ("unchanged" if rec.unchanged else "applied"),
        outcome.created,
        outcome.updated,
        outcome.deactivated,
        len(outcome.unmatched),
    )
    return status


def names_owned_elsewhere() -> tuple[str, ...]:
    """Providers whose linked people keep their names. While a Divera key is set the nightly
    Mannschaft sync owns those names; a snapshot renaming them would flip every name twice a day.
    Without a key the snapshot is the only feed and may rename everybody."""
    return ("divera",) if (credential("divera_personnel_access_key") or credential("divera_access_key")) else ()


async def busy_person_ids(db: AsyncSession, person_ids: list[str]) -> set[str]:
    """People mentioned in an Einsatz that is still running — their deactivation waits.

    Attendance, Trupps and Funktionen all live in the workspace blob keyed by the person's id, so
    the id appearing anywhere in an open Einsatz's blob is the test: a UUID does not occur by
    accident. Few Einsätze are open at once, so reading their blobs is cheap."""
    if not person_ids:
        return set()
    blobs = (await db.execute(select(Incident.map_workspace_json).where(Incident.is_archived.is_(False)))).scalars()
    text = "\n".join(json.dumps(b) for b in blobs if b)
    return {pid for pid in person_ids if pid in text}


async def due(db: AsyncSession, *, now: datetime | None = None) -> bool:
    """Has the configured interval passed since the last attempt (or was there none)?"""
    interval, _pct = await roster_policy(db)
    row = await _row(db)
    if row is None or row.last_attempt_at is None:
        return True
    last = row.last_attempt_at if row.last_attempt_at.tzinfo else row.last_attempt_at.replace(tzinfo=UTC)
    return ((now or datetime.now(UTC)) - last).total_seconds() >= interval * 60
