"""Floor packs: which page of a plan revision is which Geschoss, and what that allows.

Decided 14.09.2026 (docs/planning/gebaeude-map-module-linking.md § 6a):

* one floor per page; a revision with any ``PlanPageFloor`` row is a *floor pack*;
* ONE map fit per PDF, measured on a single page (the one the alignment row points at –
  floor 0 by default) and shared by every page, because the export convention puts the
  building at the same paper position, scale and orientation on every page.

Everything that decides whether a fit may be approved or published goes through
``fit_publishable`` so the review API, the publication API and the worker agree.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import PlanPageFloor


@dataclass(frozen=True, slots=True)
class PlanFloor:
    page: int
    index: int
    name: str | None
    #: the drawing's rectangle on the page, normalized [x0, y0, x1, y1]; None = the whole page
    clip: list[float] | None = None
    #: {"to": floor_index, "at": [x, y], "there": [x, y]}: this drawing's point ``at`` is the
    #: same building point as ``there`` on floor ``to`` – the way the drawings of one sheet are
    #: laid on each other, chained from the reference. None = whole page / not joined.
    join: dict | None = None

    def as_dict(self) -> dict:
        return {"page": self.page, "index": self.index, "name": self.name, "clip": self.clip, "join": self.join}


async def load_floors(db: AsyncSession, dataset_id: str, version: int) -> list[PlanFloor]:
    rows = (
        await db.execute(
            select(PlanPageFloor)
            .where(PlanPageFloor.dataset_id == dataset_id, PlanPageFloor.plan_version == version)
            .order_by(PlanPageFloor.floor_index)
        )
    ).scalars()
    return [PlanFloor(r.page, r.floor_index, r.floor_name, r.clip, r.join) for r in rows]


def fit_publishable(page_count: int | None, page: int, floors: list[PlanFloor]) -> bool:
    """A single-page sheet fits on page 0; a floor pack fits on any page that IS a floor.

    Any other multi-page document stays gated: the field viewer stitches it into one tall
    canvas, and a fit measured on one page would land on the wrong coordinates there.
    """
    if page_count == 1:
        return page == 0
    return any(f.page == page for f in floors)


def default_fit_page(floors: list[PlanFloor]) -> int | None:
    """Floor 0 when assigned, else the floor nearest the ground: lowest above, else highest below."""
    if not floors:
        return None
    ordered = sorted(floors, key=lambda f: f.index)
    ground_or_above = [f for f in ordered if f.index >= 0]
    return (ground_or_above[0] if ground_or_above else ordered[-1]).page


async def replace_floors(db: AsyncSession, dataset_id: str, version: int, floors: list[PlanFloor]) -> None:
    """Full replace – the floor list is one small document, edited as a whole."""
    for row in (
        await db.execute(
            select(PlanPageFloor).where(PlanPageFloor.dataset_id == dataset_id, PlanPageFloor.plan_version == version)
        )
    ).scalars():
        await db.delete(row)
    await db.flush()
    for f in floors:
        db.add(
            PlanPageFloor(
                dataset_id=dataset_id,
                plan_version=version,
                page=f.page,
                floor_index=f.index,
                floor_name=f.name,
                clip=f.clip,
                join=f.join,
            )
        )
    await db.flush()
