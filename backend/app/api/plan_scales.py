"""Station plan-scale calibration and georeferencing — editor-authored, persists across
incidents/devices.

A plan sheet has no inherent geo scale, so measuring on it needs a calibration factor
(`mPerU` + aspect ratio). Because a station's plans all come from the same generator with the
same layout, one calibration usually fits every plan (the `default`), with per-plan overrides
(`byPlan`) for the exceptions. This is EDITOR data (any FU can set it in the field), stored on
the deployment_config singleton in its own `plan_scales_json` column — kept out of the
admin-validated config so an admin push never wipes it.

The same document also carries the per-plan GEOREFERENCE (`georefByPlan`): the landmark
point-pairs that tie a plan sheet to the map, from which the client fits a similarity transform
and mirrors symbols in both directions (src/lib/georef.ts). It lives here because it answers the
same kind of question as the calibration — a property of the SHEET, not of an incident — and so
that a client loads and caches both in one request.

GET is public (viewers measure too, and it must be offline-cacheable at boot); PUT is editor-only.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentEditor
from ..database import get_db
from ..models import DeploymentConfig

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/plan-scales", tags=["plan-scales"])


class PlanScale(BaseModel):
    """Metres per aspect-corrected normalized unit + the reference/aspect it was derived at
    (mirrors src/lib/planScale.ts PlanScale)."""

    # camelCase mirrors the JSON wire format (src/lib/planScale.ts) — keep it verbatim
    mPerU: float = Field(gt=0)  # noqa: N815
    refM: float = Field(ge=0)  # noqa: N815
    ar: float = Field(gt=0)


class PlanPoint(BaseModel):
    """A point on the plan sheet, normalized 0..1 of the document box, y down — the same space
    plan annotations are stored in (src/types.ts BoardAnno.x/y).

    Bounded generously rather than exactly: a landmark may sit a hair outside the sheet, but a
    value of 1100 is plan PIXELS, and catching that here beats storing a georeference that puts
    every symbol in the North Sea."""

    x: float = Field(ge=-1, le=2)
    y: float = Field(ge=-1, le=2)


class LngLat(BaseModel):
    """WGS84 position with named fields (mirrors src/lib/georef.ts GeoPt) — a tuple here would
    make a swapped lng/lat indistinguishable from a valid one."""

    lng: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)


class GeorefPair(BaseModel):
    """One landmark seen on both surfaces. `kind` records how it came to be ('gesetzt' = newly
    placed, 'korrigiert' = an existing reference re-tapped); it carries no weight in the fit."""

    plan: PlanPoint
    lngLat: LngLat  # noqa: N815
    kind: Literal["gesetzt", "korrigiert"] | None = None


class Georef(BaseModel):
    """A plan's georeference: the landmark pairs, nothing else. The transform itself is DERIVED
    (client-side, `fitSimilarity`) and deliberately not stored — the pairs are what the operator
    placed and can correct, and a stored matrix could only ever disagree with them."""

    pairs: list[GeorefPair] = Field(default_factory=list)


class PlanScales(BaseModel):
    """The station document: one default calibration + per-plan overrides (planId → scale), plus
    the per-plan georeference (planId → pairs). Every field is optional, so a document stored
    before georeferencing existed still validates."""

    default: PlanScale | None = None
    byPlan: dict[str, PlanScale] = Field(default_factory=dict)  # noqa: N815
    georefByPlan: dict[str, Georef] = Field(default_factory=dict)  # noqa: N815


def _entries[M: BaseModel](raw: object, model: type[M], field: str) -> dict[str, M]:
    """Validate a planId → entry map one entry at a time, keeping every entry that parses."""
    if not isinstance(raw, dict):
        if raw is not None:
            logger.warning("plan_scales_json: %s is not an object (%s); dropping it", field, type(raw).__name__)
        return {}
    out: dict[str, M] = {}
    for plan_id, value in raw.items():
        try:
            out[str(plan_id)] = model.model_validate(value)
        except ValidationError:
            logger.warning("plan_scales_json: dropping malformed %s entry %r", field, plan_id, exc_info=True)
    return out


def _read_tolerantly(raw: object) -> PlanScales:
    """Parse the stored document entry by entry and drop ONLY what fails.

    Whole-document validation was fine while this held nothing but scales the app itself wrote.
    Georeferences changed that: the pairs are landmarks an operator taps, so one out-of-range
    value — or one plan still holding a pre-format entry — is a realistic single-plan defect. With
    all-or-nothing validation that one entry blanks the calibration of EVERY plan station-wide,
    at 3am, with the reason visible only in the server log. So a partially-valid document still
    serves each good entry, and the bad one is named in the log.
    """
    if not isinstance(raw, dict):
        logger.warning("plan_scales_json is not an object (%s); serving empty", type(raw).__name__)
        return PlanScales()
    default: PlanScale | None = None
    if raw.get("default") is not None:
        try:
            default = PlanScale.model_validate(raw["default"])
        except ValidationError:
            logger.warning("plan_scales_json: dropping malformed 'default' scale", exc_info=True)
    return PlanScales(
        default=default,
        byPlan=_entries(raw.get("byPlan"), PlanScale, "byPlan"),
        georefByPlan=_entries(raw.get("georefByPlan"), Georef, "georefByPlan"),
    )


async def _row(db: AsyncSession) -> DeploymentConfig | None:
    return (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()


@router.get("", response_model=PlanScales)
async def get_plan_scales(db: AsyncSession = Depends(get_db)) -> PlanScales:
    """PUBLIC — needed to measure on plans (viewers included) and cached offline at boot.
    Never raises: whatever in the stored blob does not validate is dropped entry-wise, the rest
    is served."""
    row = await _row(db)
    return _read_tolerantly(row.plan_scales_json if (row and row.plan_scales_json) else {})


@router.put("", response_model=PlanScales)
async def put_plan_scales(
    body: PlanScales,
    _editor: CurrentEditor,
    db: AsyncSession = Depends(get_db),
) -> PlanScales:
    """Editor-only. REPLACES the whole document — scales and georeferences alike — so the client
    must read-modify-write (src/lib/stationPlanScale.ts does; a body built from scratch drops the
    half it doesn't know about). Creates the singleton row if the station has no config row yet.

    ⚠️ Whole-document replace with NO optimistic-concurrency guard: there is no If-Match/version
    here, so the last PUT wins and a second editor who loaded the document earlier overwrites the
    first one's calibration or georeference without either of them noticing. Adding a guard is a
    deliberate design change (client + endpoint + a 428 path), not a drive-by fix."""
    row = await _row(db)
    doc = body.model_dump(mode="json")
    if row is None:
        row = DeploymentConfig(id=1, plan_scales_json=doc)
        db.add(row)
    else:
        row.plan_scales_json = doc
    await db.commit()
    return body
