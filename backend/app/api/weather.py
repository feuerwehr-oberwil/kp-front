"""Weather endpoints.

`GET /weather` — current wind/temp/precip for a coordinate (app/weather). 503 when
unconfigured (URLs not https), 502 on upstream failure, 404 when no provider yields data for
the point. Auth required (editor or viewer). Mirrors api/traccar.py.

`GET /weather/layer` — the Karte's radar frames of the last hour (app/weather_layer), as last
polled. It never fetches anything itself, so it answers instantly whatever the feed is doing;
`enabled: false` when the deployment switched the layer off (WEATHER_LAYER_ENABLED=false), which
the client takes as «offer no layer». No coordinate: the radar is the same picture for every
Einsatz.

`GET /weather/radar/{key}.png` — one frame. Deliberately without a session: it is MeteoSwiss's
public radar image, coloured, carries nothing about the station or the Einsatz, is served from
memory (an anonymous caller cannot make this backend fetch anything), and MapLibre loads it as
a plain image request that does not carry an incident-link page's header. Immutable: a key is a
5-minute slot.

Both layer routes are on the incident-link allowlist (auth/incident_link · LINK_ALLOWED) for the
same reason the wind is: display data on the Lage map.
"""

import httpx
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from ..auth.dependencies import CurrentUser
from ..weather import WeatherData, weather_client
from ..weather_layer import weather_layer_enabled, weather_service

router = APIRouter(prefix="/weather", tags=["weather"])


@router.get("", response_model=WeatherData)
async def weather(lat: float, lng: float, _user: CurrentUser) -> WeatherData:
    if not weather_client.is_configured:
        raise HTTPException(status_code=503, detail="Wetterdienst nicht konfiguriert")
    try:
        data = await weather_client.get_weather(lat, lng)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Wetterdienst nicht erreichbar: {e}") from e
    if data is None:
        raise HTTPException(status_code=404, detail="Keine Wetterdaten für diese Koordinate")
    return data


class WeatherSourceStatus(BaseModel):
    last_attempt_at: str | None = None
    last_success_at: str | None = None
    last_error: str | None = None
    last_error_at: str | None = None
    stale: bool | None = None


class RadarFrameOut(BaseModel):
    key: str
    time: str


class RadarLegendStep(BaseModel):
    min_mm_h: float
    color: str


class RadarOut(BaseModel):
    frames: list[RadarFrameOut]
    #: MapLibre image-source corners: top-left, top-right, bottom-right, bottom-left as [lng, lat].
    coordinates: list[list[float]] | None
    data_time: str | None
    stale: bool
    stale_after_seconds: int
    status: WeatherSourceStatus
    legend: list[RadarLegendStep]
    attribution: str
    source_url: str


class WeatherLayerOut(BaseModel):
    enabled: bool
    generated_at: str | None = None
    radar: RadarOut | None = None


@router.get("/layer", response_model=WeatherLayerOut)
async def weather_layer(_user: CurrentUser) -> WeatherLayerOut:
    """The radar frames of the last hour, as last polled."""
    if not weather_layer_enabled():
        return WeatherLayerOut(enabled=False)
    return WeatherLayerOut.model_validate(weather_service.snapshot())


@router.get(
    "/radar/{key}.png",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}, 404: {"description": "Frame not (or no longer) cached"}},
)
async def weather_radar_frame(key: str) -> Response:
    """One radar frame as a transparent PNG in Web Mercator."""
    png = weather_service.frame_png(key) if weather_layer_enabled() else None
    if png is None:
        raise HTTPException(status_code=404, detail="Radarbild nicht vorhanden")
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "public, max-age=86400, immutable"})
