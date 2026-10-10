import { useEffect, useRef, useState } from 'react'
import { apiGet } from './api'
import { serverNow } from './serverClock'
import { visibleInterval } from './visibleInterval'
import type { ApiWeatherLayer } from './weatherLayer'

/** The backend polls the radar every 5 minutes; asking it every minute keeps the Karte at most a
 *  minute behind it, for a few hundred bytes. */
const POLL_MS = 60_000
/** Staleness is re-judged on this tick even when no new answer comes (offline). */
const CLOCK_MS = 30_000

export interface WeatherLayerApi {
  /** the last good answer, kept through failed polls – it carries its own timestamps */
  data: ApiWeatherLayer | null
  /** the shared clock (`serverNow()`), ticking so «Stand hh:mm» appears on its own */
  now: number
}

/**
 * The Karte's radar (`GET /api/weather/layer`, backend app/weather_layer) – the same nationwide
 * picture for every Einsatz, so it asks without a point.
 *
 * ⚠️ Never blocks and never empties: a failed poll (offline, backend down) keeps the last
 * answer, which then goes «veraltet» by itself on the clock tick. Polling stops for good once the
 * backend answers `enabled: false` (WEATHER_LAYER_ENABLED=false) – deployment configuration does
 * not change while the page is open – and nothing of the layer is offered then.
 * `active: false` (another surface, the replay) fetches nothing and holds the last answer.
 * Paused while the page is hidden (lib/visibleInterval), like the wind reading.
 */
export function useWeatherLayer(active: boolean): WeatherLayerApi {
  const [data, setData] = useState<ApiWeatherLayer | null>(null)
  const [now, setNow] = useState(() => serverNow())
  const [off, setOff] = useState(false)
  // when the last answer came — a hop to another surface and back to the Karte must not cost a
  // request each time (the perf journeys walk every surface four times)
  const lastAt = useRef<number | null>(null)

  useEffect(() => {
    if (!active || off) return
    let alive = true
    const poll = async () => {
      const last = lastAt.current
      if (last !== null && Date.now() - last < POLL_MS / 2) return
      try {
        const next = await apiGet<ApiWeatherLayer>('/api/weather/layer')
        if (!alive) return
        lastAt.current = Date.now()
        setData(next)
        setNow(serverNow())
        if (!next.enabled) setOff(true)
      } catch {
        // keep the last answer: it ages into «Stand hh:mm» on its own
      }
    }
    const stop = visibleInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      stop()
    }
  }, [active, off])

  const enabled = data?.enabled === true
  useEffect(() => {
    if (!active || !enabled) return
    return visibleInterval(() => setNow(serverNow()), CLOCK_MS, { leading: false })
  }, [active, enabled])

  return { data, now }
}
