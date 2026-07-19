"""Per-station deployment config: public GET (branding before login) + editor PUT.

The config document shape is defined in docs/CONFIGURATION.md §1 and validated through
``DeploymentConfigIn`` in schemas.py. The singleton row (id=1) is seeded empty on startup.

Response contract (both GET and PUT return the SAME projection ``DeploymentConfigOut``):

    {
      "identity": { "appName": null, "locale": null, "accentColor": null,
                    "assets": {"logo": null, "iconPng192": null, "iconPng512": null, "favicon": null},
                    "helpIntro": null },
      "map": { "defaultView": {"center": null, "centerLv95": null, "zoom": null},
               "geocoder": {"defaultLocality": null, "bboxLv95": null} },
      "referenceLayers": [ { "id": ..., "group": ..., "label": ..., "icon": ...,
                             "kind": "wms"|"wmts"|"geojson", "tiles": [...]|null,
                             "geojson": ...|null, "vectorKind": ..., "symbol": ...,
                             "color": ..., "nightColor": ..., "opacity": ...,
                             "maxzoom": ..., "attribution": ... } ],
      "fleet": { "attributeLists": [ {"symbol": ..., "field": ..., "options": [...]} ],
                 "vehicleTypes": [], "luefterTypes": [], "kleinloeschTypes": [],   # legacy
                 "partner": {"feuerwehr": [], "sanitaet": [], "polizei": [],
                             "chemiewehr": [], "zivilschutz": []} },
      "doctrine": { "defaultFunkkanal": null, "funkkanalMin": null, "funkkanalMax": null,
                    "mindestBar": null, "contactIntervalMin": null,
                    "contactGraceSec": null, "defaultPressureBar": null,
                    "pressureStep": null, "pressureMax": null },
      "roster": { "source": "manual"|"divera"|null },
      "integrations": { "diveraConfigured": bool, "traccarConfigured": bool }   # env-derived
    }

Never exposes ``updated_by``, raw secrets, or API keys. On a fresh / empty / corrupt DB
row, GET serves the safe empty config above — never 404, never 500.
"""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin, OptionalUser
from ..database import get_db
from ..i18n import set_locale
from ..models import DeploymentConfig, User
from ..providers import integrations
from ..schemas import DeploymentConfigIn, DeploymentConfigOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config", tags=["config"])


def _projection(doc: DeploymentConfigIn) -> DeploymentConfigOut:
    """Validated document + env-derived integration flags → the public projection."""
    return DeploymentConfigOut(**doc.model_dump(), integrations=integrations())


@router.get("", response_model=DeploymentConfigOut)
async def get_config(db: AsyncSession = Depends(get_db)) -> DeploymentConfigOut:
    """PUBLIC (no auth) — the login screen needs branding before login.

    Last-good fallback: if the persisted ``config_json`` is missing or fails validation
    (e.g. a hand-edited bad row), serve a safe empty config and log a warning. Never raises.
    """
    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
    raw = row.config_json if (row and row.config_json) else {}
    try:
        doc = DeploymentConfigIn.model_validate(raw)
    except Exception:  # noqa: BLE001 — never let a bad stored row brick GET
        logger.warning("deployment_config row failed validation; serving empty fallback", exc_info=True)
        doc = DeploymentConfigIn()
    return _projection(doc)


@router.get("/meta")
async def get_config_meta(
    _admin: CurrentAdmin,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Admin-only audit metadata for the singleton config row: when it was last saved
    and who saved it (resolved display name). Returns plain nulls on a fresh / unstamped row.
    """
    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
    if row is None:
        return {"updated_at": None, "updated_by_name": None}
    name: str | None = None
    if row.updated_by is not None:
        name = (
            await db.execute(select(User.display_name).where(User.id == row.updated_by))
        ).scalar_one_or_none()
    updated_at = row.updated_at.isoformat() if row.updated_at else None
    return {"updated_at": updated_at, "updated_by_name": name}


@router.put("", response_model=DeploymentConfigOut)
async def put_config(
    body: DeploymentConfigIn,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    db: AsyncSession = Depends(get_db),
) -> DeploymentConfigOut:
    """Admin-only. Validates the body (422 on invalid), persists the document to the
    singleton row, stamps ``updated_by`` (the admin's user when driving the UI, NULL for
    a CLI push), and returns the same projection as GET.
    """
    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
    # Persist the normalized document (defaults filled in) so GET round-trips consistently.
    doc_json = body.model_dump(mode="json")
    actor_id = actor.id if actor else None
    if row is None:
        row = DeploymentConfig(id=1, config_json=doc_json, updated_by=actor_id)
        db.add(row)
    else:
        row.config_json = doc_json
        row.updated_by = actor_id
    await db.flush()
    # Refresh the cached locale used for error-detail i18n.
    set_locale(body.identity.locale if body.identity else None)
    return _projection(body)
