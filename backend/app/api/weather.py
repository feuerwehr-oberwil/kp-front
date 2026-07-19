"""Weather endpoint — current wind/temp/precip for a coordinate.

503 when unconfigured (URLs not https), 502 on upstream failure, 404 when no provider
yields data for the point. Auth required (editor or viewer). Mirrors api/traccar.py.
"""

import httpx
from fastapi import APIRouter, HTTPException

from ..auth.dependencies import CurrentUser
from ..weather import WeatherData, weather_client

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
