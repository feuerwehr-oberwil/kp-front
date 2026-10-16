"""Seed the DEMO's Objektbesuche: one finished visit at Schloss Musterdorf and the round it is in.

Without it the demo's «Objektbesuche» opened on an empty overview — no round, no «zuletzt
besucht», no report — and a visitor had nothing to read before trying the module themselves.
What it writes (docs/object-visits.md is the contract):

- a published round (``visit_programmes`` → one ``visit_lists`` row, the organizer's path) with
  two stops, scheduled TODAY, so the overview lands on «Heute» at 1/2: the Schloss done, the
  Gewerbehaus at Gewerbestrasse 4 (the closed BMA-Einsatz's address) still open;
- the Gewerbehaus itself, as the plan-less key-box object an organizer pushes
  (``upsert_integration_object``) — it stays off every Einsatz surface by that contract;
- one COMPLETED visit at the Schloss, yesterday evening, on the demo checklist
  (``examples/demo-data/checklists/musterdorf-objektbesuch.json``), with one Mangel and one
  Korrekturvorschlag so the report shows both. No photos: they would need stored bytes.

The visit goes through ``object_visits.apply_put`` — the field API's own write — so its revision
row, readiness and feed number are exactly what a device would have produced. The «Neuer
Objektbesuch» push that completion queues reaches nobody: no demo account is ticked
(``users.notify_object_visits``), and the demo has no VAPID keys.

⚠️ SEEDING ORDER. Everything here hangs off the Schloss, and this repo never creates the Schloss
in SQL — ``admin_objects`` does, from ``objects.manifest.json``. Seeding BEFORE it exists is not
an option either: ``object_visits.object_id`` is ON DELETE SET NULL and ``object_refs`` cascade,
so a visit seeded ahead of the object wipe survives detached — no «zuletzt besucht», the round
reads 0/2. So the seed runs on both reset paths and SKIPS (logged, not an error) when the Schloss
is not there:

- the in-process cron calls ``demo_reset.reset(wipe_objects=False)``: the Schloss is kept, and
  ``reset()`` seeds at its end;
- ``scripts/demo-reset.sh`` runs ``reset()`` with the object wipe — that seed skips — then pushes
  the objects (step 4) and runs THIS module (step 4b), which seeds against the fresh Schloss.

Idempotent: it clears its own rows first (fixed ids), so a rerun or a retry never doubles a visit.

    KP_DEMO_RESET=1 DATABASE_URL=<demo db> uv run python -m app.demo_object_visits

DEMO ONLY — gated on KP_DEMO_RESET=1 like ``demo_reset``.
"""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import object_visits as ov
from . import storage, visit_programmes
from .database import async_session_maker
from .demo_reset import ZURICH, NotADemoDatabaseError, assert_demo_database, demo_display_name
from .models import ObjectSite, ObjectVisit, ObjectVisitAttachment, User, VisitList, VisitProgramme

logger = logging.getLogger(__name__)

DEMO_DATA = Path(__file__).resolve().parents[2] / "examples" / "demo-data"
CHECKLIST_PATH = DEMO_DATA / "checklists" / "musterdorf-objektbesuch.json"

#: Schloss Musterdorf — the fixed id in ``objects.manifest.json``.
SCHLOSS_ID = uuid.UUID("d0000000-0000-5000-8000-00000000b077")
#: The organizer source the demo's refs live under (``object_refs.source``).
REF_SOURCE = "demo"
SCHLOSS_REF = "schloss-musterdorf"
GEWERBEHAUS_REF = "gewerbestrasse-4"
#: Plan-less, so the organizer path creates it. Same address and spot as the closed BMA-Einsatz
#: in ``demo_reset`` — the BMA that went off there is why it is on the round.
GEWERBEHAUS = {
    "name": "Gewerbehaus Gewerbestrasse 4",
    "address": "Gewerbestrasse 4, 9999 Musterdorf",
    "lat": 47.5165459755087,
    "lng": 7.56193049830498,
}

PROGRAMME_REF = "demo:objektbesuche"
ROUTE_CODE = "R1"
ROUTE_TITLE = "Schlüsseldepots Dorfkern"

#: Derived, not minted: a reset must find and replace the same visit (ids match ``ID_RE``).
VISIT_ID = "ovdemo-schloss"
#: Yesterday at this local time — an Übungsabend, and before any reset that can run today.
VISIT_LOCAL_TIME = time(18, 40)


def build_visit_doc(checklist: dict[str, Any], obj: dict[str, Any], work_ref: str, visited_at: datetime) -> dict:
    """The finished visit document (``kp-front.object-visit/1``). Pure — no DB/file access."""
    visited = visited_at.astimezone(ZURICH).isoformat(timespec="seconds")
    return {
        "schema": ov.SCHEMA,
        "id": VISIT_ID,
        "object": obj,
        "workRef": work_ref,
        "visitedAt": visited,
        "with": [demo_display_name("Stefan", "Graf"), demo_display_name("Nina", "Frei")],
        "lifecycle": "completed",
        "checklist": checklist,
        # every item answered except the photo: a missing key reads «nicht geprüft», never «Nein»
        "answers": {
            "zufahrt-frei": {"v": "ok"},
            "zufahrt-signalisiert": {"v": "yes"},
            "stellflaeche": {"v": "ok"},
            "hydranten-frei": {"v": "ok"},
            "depot-zugaenglich": {"v": "ok"},
            "depot-oeffnen": {"v": "ok"},
            "schluessel-anzahl": {"v": 3},
            "schluessel-schliessen": {"v": "ok"},
            "depot-zustand": {"v": "gut"},
            "bma-zentrale": {"v": "ok"},
            "bma-stoerung": {"v": "ok"},
            "laufkarten": {"v": "defect", "note": "Laufkarte Melder 2. OG Nordflügel fehlt."},
            "feuerwehrplan": {"v": "yes"},
            "ansprechperson": {"v": "Hauswart"},
            "fluchtwege": {"v": "ok"},
        },
        "notes": (
            "Schlüsseldepot beim Haupttor geprüft, alle drei Schlüssel schliessen. "
            "Fehlende Laufkarte mit dem Hauswart besprochen, die Verwaltung reicht sie nach."
        ),
        "photos": [],
        "proposals": [
            {
                "id": "ovpdemo-schloss-1",
                "field": "owner_contact",
                "label": "Kontakt Eigentümer",
                "current": "Schlossverwaltung, Tel. 000 000 00 00",
                "proposed": "Schlossverwaltung, Tel. 000 000 00 01 (neue Nummer seit Sommer)",
                "reason": "Vom Hauswart beim Besuch genannt.",
                "base": {"source": "kp-front", "asOf": visited},
            }
        ],
        "conflicts": [],
    }


async def _clear(db: AsyncSession) -> None:
    """This seed's own rows, so it can run again. ``reset()`` has wiped them already; the CLI
    step may be a retry. A visitor may have added photos to the seeded visit — their files go
    once the delete commits, the way the demo wipe lets them go."""
    for key in (
        await db.execute(select(ObjectVisitAttachment.storage_key).where(ObjectVisitAttachment.visit_id == VISIT_ID))
    ).scalars():
        for derived in ("", ".thumb.jpg"):
            storage.delete_after_commit(db, key + derived)
    await db.execute(delete(ObjectVisit).where(ObjectVisit.id == VISIT_ID))
    await db.execute(delete(VisitList).where(VisitList.ref.startswith(f"{PROGRAMME_REF}-")))
    await db.execute(delete(VisitProgramme).where(VisitProgramme.ref == PROGRAMME_REF))


async def seed_object_visits(db: AsyncSession, *, now: datetime | None = None) -> bool:
    """Seed the round + the finished Schloss visit into ``db`` (flushed, NOT committed — the
    caller owns the transaction). False when the Schloss is not there yet (see the module doc)."""
    assert_demo_database()  # it deletes (its own rows) — same gate as reset(), every caller covered
    now = now or datetime.now(UTC)
    # A query, not db.get(): reset() has just bulk-deleted the objects in this same session.
    schloss = (await db.execute(select(ObjectSite).where(ObjectSite.id == SCHLOSS_ID))).scalar_one_or_none()
    if schloss is None:
        logger.info("Demo Objektbesuche: Schloss Musterdorf not loaded yet — skipped (seeded after the object push)")
        return False
    await _clear(db)

    await ov.attach_refs(db, SCHLOSS_ID, [(REF_SOURCE, SCHLOSS_REF)])
    await ov.upsert_integration_object(db, REF_SOURCE, GEWERBEHAUS_REF, GEWERBEHAUS)

    today = now.astimezone(ZURICH).date()
    stops = [{"source": REF_SOURCE, "id": SCHLOSS_REF}, {"source": REF_SOURCE, "id": GEWERBEHAUS_REF}]
    # the organizer's own two calls — routes, then the year — so the round is a real publication
    await visit_programmes.save_routes(
        db,
        PROGRAMME_REF,
        visit_programmes.RoutesUpdate.model_validate(
            {"revision": 0, "routes": [{"code": ROUTE_CODE, "title": ROUTE_TITLE, "objects": stops}]}
        ),
    )
    await visit_programmes.publish(
        db,
        PROGRAMME_REF,
        today.year,
        visit_programmes.Publish.model_validate(
            {"revision": 1, "assignments": [{"code": ROUTE_CODE, "scheduledOn": today.isoformat()}]}
        ),
    )
    work_ref = f"{PROGRAMME_REF}-{today.year}/{ROUTE_CODE}"

    checklist = json.loads(CHECKLIST_PATH.read_text(encoding="utf-8"))
    refs = await ov.refs_by_object(db)
    obj = {
        "id": str(SCHLOSS_ID),
        "name": schloss.name,
        "address": schloss.address,
        "folder": ov.object_folder(schloss),
        "refs": refs.get(SCHLOSS_ID, []),
    }
    visited_at = datetime.combine(today - timedelta(days=1), VISIT_LOCAL_TIME, tzinfo=ZURICH)
    fu = (await db.execute(select(User).where(User.username == "fu"))).scalar_one_or_none()
    actor = ov.Actor(fu.id, fu.display_name) if fu else ov.Actor(None, None)
    await ov.apply_put(
        db,
        VISIT_ID,
        {
            "opId": "ovodemo-schloss-1",
            "baseRevision": None,
            "doc": build_visit_doc(checklist, obj, work_ref, visited_at),
        },
        actor,
        now=visited_at + timedelta(minutes=35),
    )
    logger.info("Demo Objektbesuche: round %s (scheduled %s) + 1 finished visit at the Schloss", work_ref, today)
    return True


async def main() -> None:
    async with async_session_maker() as db:
        if await seed_object_visits(db):
            await db.commit()
        else:
            # the CLI step runs AFTER the object push: no Schloss here means that push failed
            raise SystemExit(
                "Schloss Musterdorf is not loaded — run the object push first (scripts/demo-reset.sh 4/7)."
            )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        assert_demo_database()
    except NotADemoDatabaseError as exc:
        raise SystemExit(str(exc)) from None
    asyncio.run(main())
