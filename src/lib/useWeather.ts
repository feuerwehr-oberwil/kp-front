import { useEffect, useMemo, useRef, useState } from 'react'
import type { LngLat, WeatherData } from '../types'
import { appConfig } from '../config/appConfig'
import { apiGet } from './api'

const POLL_MS = 10 * 60_000 // observations refresh ~every 10 min

export interface WeatherApi {
  data: WeatherData | null
  /** last fetch error message, if any (backend down, unconfigured, no data for point) */
  error: string | null
}

/**
 * Polls the backend `/api/weather` for current conditions near `center`. The backend
 * picks the nearest MeteoSwiss station (Open-Meteo fallback) and TTL-caches, so polling
 * every ~10 min is cheap. Re-fetches when the incident center moves enough to round to a
 * different ~1 km cell. Returns `{ data, error }`; `data` is null while loading / on error.
 */
export function useWeather(center: LngLat): WeatherApi {
  const [data, setData] = useState<WeatherData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  // Round the key so a sub-km map jitter doesn't re-fire the effect every render.
  const lat = Math.round(center[1] * 100) / 100
  const lng = Math.round(center[0] * 100) / 100

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await apiGet<WeatherData>(`/api/weather?lat=${lat}&lng=${lng}`)
        if (!alive) return
        setData(res)
        setError(null)
      } catch {
        if (!alive) return
        // one friendly localized string for EVERY failure mode (backend down, unconfigured,
        // no data for the point) — raw fetch/server error text never reaches the UI
        setError(appConfig.copy.weather.unavailable)
      }
    }
    void poll()
    timer.current = window.setInterval(poll, POLL_MS)
    return () => {
      alive = false
      if (timer.current != null) window.clearInterval(timer.current)
    }
  }, [lat, lng])

  return useMemo(() => ({ data, error }), [data, error])
}
