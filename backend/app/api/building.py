"""``GET /api/incidents/{id}/building`` — the Gebäude card of an Einsatz (KP Front card F5).

Four halves, each optional and each failing on its own (docs/building-card.md):

1. GWR facts about the building at the Einsatzort,
2. the BFE plants registered on it (PV),
3. the Einsatzobjekt's Sofortmassnahmen (station data, `ObjectSite.measures`),
4. that object's last completed Objektbesuch — date and Mängel.

1–2 are the federal registers (app/building_facts) and are asked only inside Switzerland and
unless the station switched them off (``map.buildingRegister: false``). 3–4 are the station's own
and come either way. The device caches the whole answer per Einsatz for offline.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentUser
from ..building_facts import in_switzerland, registers_cached
from ..database import get_db
from ..geo_util import haversine_m
from ..models import DeploymentConfig, Incident, ObjectSite, ObjectVisit
from ..object_visits import ov_config
from ..schemas import (
    BuildingGwrOut,
    BuildingObjectOut,
    BuildingOut,
    BuildingPlantOut,
    BuildingVisitOut,
    load_stored_config,
)
from .incidents import get_incident_or_404
from .objects import _norm_addr, ranked_objects_near

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/incidents", tags=["objects"])

_LANGS = {"de", "fr", "it", "en"}


async def _register_switch(db: AsyncSession) -> bool | None:
    """``map.buildingRegister`` from the stored config; None (= auto) when unset or unreadable."""
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    try:
        return load_stored_config((row.config_json if row else None) or {}).map.buildingRegister
    except Exception:  # noqa: BLE001 — a broken stored document must not take the card down
        logger.warning("deployment config failed validation — Gebäude registers read as auto", exc_info=True)
        return None


async def _object_for(
    db: AsyncSession, inc: Incident, object_id: uuid.UUID | None
) -> tuple[ObjectSite, float | None, bool] | None:
    """The object the card speaks for: the operator's pick when given, else the plan rail's first."""
    if object_id is not None:
        o = (await db.execute(select(ObjectSite).where(ObjectSite.id == object_id))).scalar_one_or_none()
        if o is not None:
            ia, oa = _norm_addr(inc.address), _norm_addr(o.address)
            matched = bool(ia) and bool(oa) and (ia == oa or oa.startswith(ia) or ia.startswith(oa))
            dist = (
                haversine_m(float(inc.lat), float(inc.lng), float(o.lat), float(o.lng))
                if inc.lat is not None and inc.lng is not None and o.lat is not None and o.lng is not None
                else None
            )
            return o, dist, matched
    ranked = await ranked_objects_near(db, inc)
    return ranked[0] if ranked else None


async def _last_visit(db: AsyncSession, object_id: uuid.UUID) -> ObjectVisit | None:
    return (
        await db.execute(
            select(ObjectVisit)
            .where(
                ObjectVisit.object_id == object_id,
                ObjectVisit.lifecycle == "completed",
                ObjectVisit.visited_at.is_not(None),
            )
            .order_by(ObjectVisit.visited_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


@router.get("/{incident_id}/building", response_model=BuildingOut)
async def incident_building(
    incident_id: uuid.UUID,
    user: CurrentUser,
    object_id: uuid.UUID | None = Query(default=None, alias="object"),
    lang: str = "de",
    db: AsyncSession = Depends(get_db),
) -> BuildingOut:
    inc = await get_incident_or_404(db, incident_id)
    lang = lang if lang in _LANGS else "de"
    out = BuildingOut(registers="on")

    # --- 1+2: the federal registers -------------------------------------------------------
    switch = await _register_switch(db)
    if switch is False:
        out.registers = "off"
    elif inc.lat is None or inc.lng is None:
        out.registers = "no_location"
    elif not in_switzerland(float(inc.lat), float(inc.lng)):
        out.registers = "outside_ch"
    else:
        ans = await registers_cached(float(inc.lat), float(inc.lng), inc.address, lang)
        out.registers_fetched_at = ans.fetched_at
        out.egid, out.address = ans.egid, ans.address
        if not ans.gwr_ok:
            out.gwr_status = "error"
        elif ans.gwr is None:
            out.gwr_status = "none"
        else:
            out.gwr_status = "ok"
            out.gwr = BuildingGwrOut(**{k: v for k, v in ans.gwr.items() if k != "egid"})
        if ans.pv_asked:
            out.pv_status = "ok" if ans.pv_ok else "error"
            out.plants = [BuildingPlantOut(**p) for p in ans.plants]

    # --- 3+4: the station's own object -----------------------------------------------------
    picked = await _object_for(db, inc, object_id)
    if picked is not None:
        o, dist, matched = picked
        out.object = BuildingObjectOut(
            id=o.id,
            name=o.name,
            address_match=matched,
            distance_m=dist,
            measures=o.measures,
            remarks=o.remarks,
            measures_source=o.measures_source,
            updated_at=o.updated_at,
        )
        # The Objektbesuche are the module's own business: only where the station runs it, and
        # never for a link session (api/object_visits refuses those every visit).
        is_link = bool(getattr(user, "link_kind", None)) or bool(getattr(user, "link_scoped", False))
        if not is_link and (await ov_config(db)).enabled and (v := await _last_visit(db, o.id)) is not None:
            out.visit = BuildingVisitOut(id=v.id, visited_at=v.visited_at, findings=v.findings or 0)
    return out
