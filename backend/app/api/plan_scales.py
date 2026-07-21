"""Station plan-scale calibration — editor-authored, persists across incidents/devices.

A plan sheet has no inherent geo scale, so measuring on it needs a calibration factor
(`mPerU` + aspect ratio). Because a station's plans all come from the same generator with the
same layout, one calibration usually fits every plan (the `default`), with per-plan overrides
(`byPlan`) for the exceptions. This is EDITOR data (any FU can set it in the field), stored on
the deployment_config singleton in its own `plan_scales_json` column — kept out of the
admin-validated config so an admin push never wipes it.

GET is public (viewers measure too, and it must be offline-cacheable at boot); PUT is editor-only.
"""
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
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


class PlanScales(BaseModel):
    """The station calibration document: one default + per-plan overrides (planId → scale)."""

    default: PlanScale | None = None
    byPlan: dict[str, PlanScale] = Field(default_factory=dict)  # noqa: N815


async def _row(db: AsyncSession) -> DeploymentConfig | None:
    return (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()


@router.get("", response_model=PlanScales)
async def get_plan_scales(db: AsyncSession = Depends(get_db)) -> PlanScales:
    """PUBLIC — needed to measure on plans (viewers included) and cached offline at boot.
    Never raises: a malformed stored blob falls back to empty."""
    row = await _row(db)
    raw = row.plan_scales_json if (row and row.plan_scales_json) else {}
    try:
        return PlanScales.model_validate(raw)
    except Exception:  # noqa: BLE001 — a bad row must not brick measuring
        logger.warning("plan_scales_json failed validation; serving empty", exc_info=True)
        return PlanScales()


@router.put("", response_model=PlanScales)
async def put_plan_scales(
    body: PlanScales,
    _editor: CurrentEditor,
    db: AsyncSession = Depends(get_db),
) -> PlanScales:
    """Editor-only. Replaces the whole document (the client sends the merged result). Creates
    the singleton row if the station has no config row yet."""
    row = await _row(db)
    doc = body.model_dump(mode="json")
    if row is None:
        row = DeploymentConfig(id=1, plan_scales_json=doc)
        db.add(row)
    else:
        row.plan_scales_json = doc
    await db.commit()
    return body
