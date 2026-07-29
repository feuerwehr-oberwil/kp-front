"""Overpass proxy — building outlines for the «Umrisse» surface.

The browser posts its bounding-box query here instead of to the public Overpass mirrors, so
the only host it talks to is its own origin. See ..overpass for the reasoning and the mirror
race; this module is just the authenticated seam.

Auth required (editor or viewer), same as the geocoder: without it this would be an open
relay that anyone could point at Overpass using the station's address.
"""

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from .. import overpass as overpass_client
from ..auth.dependencies import CurrentUser

router = APIRouter(prefix="/overpass", tags=["overpass"])

# Overpass QL is a query language, and this endpoint is authenticated but not admin-only, so
# the query is not forwarded verbatim — the client sends a bounding box and the server builds
# the query. That keeps the relay from being a general-purpose Overpass console.
_QUERY = '[out:json][timeout:25];(way["building"]({bbox});relation["building"]({bbox}););out geom;'


class BuildingsRequest(BaseModel):
    """A WGS84 bounding box. Ordering matches Overpass: south, west, north, east."""

    south: float = Field(ge=-90, le=90)
    west: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)


@router.post("/buildings")
async def buildings(_user: CurrentUser, box: BuildingsRequest) -> dict:
    """Building footprints inside the bbox, in Overpass' own JSON shape.

    The response is passed through unchanged so the client-side projection code did not have
    to change when this moved server-side.
    """
    if box.south >= box.north or box.west >= box.east:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "leere oder invertierte Bounding-Box")

    if not overpass_client.mirrors():
        # Configured off (or misconfigured to non-https only). The surface treats this the
        # same as an upstream failure and offers a retry, which is the honest outcome.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Overpass ist nicht konfiguriert")

    bbox = f"{box.south},{box.west},{box.north},{box.east}"
    try:
        return await overpass_client.fetch_buildings(_QUERY.format(bbox=bbox))
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Overpass nicht erreichbar") from exc
