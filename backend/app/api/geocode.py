"""Geocoder endpoint — address → ranked WGS84 suggestions for the intake autocomplete.

Region-biased swisstopo search (see ..geocode). Auth required (editor or viewer).
Returns an empty list (never an error) on no match / upstream failure so the wizard
degrades to manual map-click placement.
"""

from fastapi import APIRouter, Query

from ..auth.dependencies import CurrentUser
from ..geocode import reverse, search
from ..schemas import GeoHit

router = APIRouter(prefix="/geocode", tags=["geocode"])


@router.get("/search", response_model=list[GeoHit])
async def geocode_search(
    _user: CurrentUser,
    q: str = Query(min_length=1),
    limit: int = Query(default=6, ge=1, le=20),
) -> list[GeoHit]:
    hits = await search(q, limit=limit)
    return [GeoHit(label=h.label, lat=h.lat, lng=h.lng) for h in hits]


@router.get("/reverse", response_model=GeoHit | None)
async def geocode_reverse(
    _user: CurrentUser,
    lat: float = Query(ge=-90, le=90),
    lng: float = Query(ge=-180, le=180),
) -> GeoHit | None:
    """Nearest registered address to a map-clicked point; null on no match/failure."""
    hit = await reverse(lat, lng)
    return GeoHit(label=hit.label, lat=hit.lat, lng=hit.lng) if hit else None
