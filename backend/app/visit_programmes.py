"""Organizer-owned reusable routes and atomic annual publication.

Routes never appear on the field surface. Publishing snapshots them into ordinary work
lists. Existing rounds keep their stops and completions; only their date/visibility changes.
The revision guards two administrators editing at once. No visit is written or removed.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints, model_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from . import object_visits as ov
from .models import VisitList, VisitProgramme

Code = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9-]{0,39}$")]


class ObjectRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    id: str = Field(min_length=1, max_length=300)


class Route(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: Code
    title: str = Field(min_length=1, max_length=150)
    objects: list[ObjectRef] = Field(min_length=1, max_length=500)
    retired: bool = False

    @model_validator(mode="after")
    def unique_objects(self):
        if len({(o.source, o.id) for o in self.objects}) != len(self.objects) or not self.title.strip():
            raise ValueError("Route braucht einen Namen und darf keine doppelten Halte enthalten.")
        return self


class RoutesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: StrictInt = Field(ge=0)
    routes: list[Route] = Field(max_length=200)


class Assignment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: Code
    scheduled_on: date = Field(alias="scheduledOn")


class Publish(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: StrictInt = Field(ge=0)
    assignments: list[Assignment] = Field(max_length=200)


def check_ref(ref: str) -> None:
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9:._-]{0,99}", ref):
        raise ov.invalid("Ungültige Planungsreferenz")


def view(row: VisitProgramme | None) -> dict:
    return (
        {"revision": row.revision, "routes": row.routes, "years": row.years}
        if row
        else {"revision": 0, "routes": [], "years": []}
    )


async def read(db: AsyncSession, ref: str) -> dict:
    check_ref(ref)
    return view(await db.get(VisitProgramme, ref))


async def require_unmanaged(db: AsyncSession, ref: str) -> None:
    """An old organizer client must not overwrite a published round's snapshot."""
    match = re.fullmatch(r"(.+)-(\d{4})/[^/]+", ref)
    if match:
        programme = (
            await db.execute(select(VisitProgramme).where(VisitProgramme.ref == match[1]).with_for_update())
        ).scalar_one_or_none()
        if programme and int(match[2]) in programme.years:
            raise ov.ObjectVisitError(409, "managed_list", "Diese Runde wird über die Jahresplanung verwaltet.")


async def require_unused_ref(db: AsyncSession, source: str, external_id: str) -> None:
    """Legacy cleanup cannot detach buildings still used by a route or historic round."""
    programmes = (
        (await db.execute(select(VisitProgramme).order_by(VisitProgramme.ref).with_for_update())).scalars().all()
    )

    def contains(items: list) -> bool:
        return any(item.get("source") == source and item.get("id") == external_id for item in items)

    for programme in programmes:
        if any(contains(route["objects"]) for route in programme.routes):
            raise ov.ObjectVisitError(409, "planned_object", "Das Gebäude gehört zu einer gespeicherten Route.")
        rounds = (await db.execute(select(VisitList).where(VisitList.ref.startswith(programme.ref + "-")))).scalars()
        if any(contains(item.items) for item in rounds):
            raise ov.ObjectVisitError(409, "planned_object", "Das Gebäude gehört zu einer bestehenden Runde.")


async def locked(db: AsyncSession, ref: str, revision: int) -> VisitProgramme:
    check_ref(ref)
    # Concurrent first saves also serialize; the losing writer sees revision 1, not a PK error.
    await db.execute(insert(VisitProgramme).values(ref=ref, revision=0, routes=[], years=[]).on_conflict_do_nothing())
    row = (await db.execute(select(VisitProgramme).where(VisitProgramme.ref == ref).with_for_update())).scalar_one()
    if row.revision != revision:
        raise ov.ObjectVisitError(
            409, "planning_conflict", "Die Planung wurde inzwischen geändert. Neu laden und Änderungen prüfen."
        )
    return row


async def save_routes(db: AsyncSession, ref: str, body: RoutesUpdate) -> dict:
    ov.refuse_unstorable(body.model_dump())
    codes = [r.code for r in body.routes]
    if len(set(codes)) != len(codes):
        raise ov.invalid("Routencodes müssen eindeutig sein")
    row = await locked(db, ref, body.revision)
    # Retirement is reversible and keeps the route's identity for old rounds.
    if {r["code"] for r in row.routes} - set(codes):
        raise ov.invalid("Bestehende Routen stilllegen statt löschen")
    row.routes = [r.model_dump() for r in body.routes]
    row.revision += 1
    await db.flush()
    return view(row)


async def publish(db: AsyncSession, ref: str, year: int, body: Publish) -> dict:
    if not 2000 <= year <= 2200:
        raise ov.invalid("Ungültiges Planungsjahr")
    codes = [a.code for a in body.assignments]
    if len(set(codes)) != len(codes) or any(a.scheduled_on.year != year for a in body.assignments):
        raise ov.invalid("Jede Route einmal auswählen und ein Datum im Planungsjahr angeben")
    row = await locked(db, ref, body.revision)
    routes = {r["code"]: r for r in row.routes}
    prefix = f"{ref}-{year}/"
    existing = {
        item.ref: item
        for item in (await db.execute(select(VisitList).where(VisitList.ref.startswith(prefix)))).scalars()
    }
    for assignment in body.assignments:
        key = prefix + assignment.code
        route = routes.get(assignment.code)
        if not route or (route.get("retired") and key not in existing):
            raise ov.invalid(f"Route {assignment.code} ist nicht verfügbar")
        if key not in existing:
            result = await ov.put_visit_list(
                db, key, {"title": f"{year} · {route['title']}", "objects": route["objects"]}
            )
            if result["unresolved"]:
                raise ov.invalid(f"Route {assignment.code}: Gebäude fehlen. Route vor dem Veröffentlichen prüfen.")
            existing[key] = (await db.execute(select(VisitList).where(VisitList.ref == key))).scalar_one()
        item = existing[key]
        # Stable ref and snapshot: rescheduling and withdrawing never touch completed checks.
        item.scheduled_on = assignment.scheduled_on
        item.archived = False
    chosen = {prefix + code for code in codes}
    for key, item in existing.items():
        if key not in chosen:
            item.archived = True
    row.years = sorted(set(row.years) | {year})
    row.revision += 1
    await db.flush()
    return view(row)
