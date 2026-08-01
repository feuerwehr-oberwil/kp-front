import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'

const cfg = appConfig.gps

/** One point of a vehicle's recorded track, as the backend returns it. */
export interface TrailPoint {
  lat: number
  lng: number
  ts?: string
  course?: number | null
  speed?: number | null
}

export interface VehicleTrail {
  device_id: number
  device_name: string
  points: TrailPoint[]
}

/** GeoJSON LineString feature collection — the shape MapView's `<Source>` wants. */
export interface TrailFeatureCollection {
  type: 'FeatureCollection'
  features: {
    type: 'Feature'
    properties: { device_id: number; device_name: string }
    geometry: { type: 'LineString'; coordinates: [number, number][] }
  }[]
}

export const EMPTY_TRAILS: TrailFeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Trails → GeoJSON, dropping anything that cannot be drawn.
 *
 * A LineString needs two points; a device with one fix (or none) would otherwise produce an
 * empty geometry that MapLibre renders as nothing while still costing a feature. Non-finite
 * coordinates are dropped rather than passed on: one NaN makes MapLibre discard the whole
 * source, so a single bad fix would silently take every other vehicle's track with it.
 */
export function trailsToGeoJSON(trails: VehicleTrail[]): TrailFeatureCollection {
  const features = trails.flatMap((t) => {
    const coordinates = (t.points ?? [])
      .filter((p) => Number.isFinite(p?.lng) && Number.isFinite(p?.lat))
      .map((p): [number, number] => [p.lng, p.lat])
    if (coordinates.length < 2) return []
    return [
      {
        type: 'Feature' as const,
        properties: { device_id: t.device_id, device_name: t.device_name },
        geometry: { type: 'LineString' as const, coordinates },
      },
    ]
  })
  return { type: 'FeatureCollection', features }
}

/**
 * Polls the recorded vehicle tracks — but ONLY while `enabled`.
 *
 * The Fahrzeugspuren layer is off by default, so for most incidents this hook never issues a
 * request at all. Turning the layer off stops the timer and clears what was drawn, rather than
 * leaving a frozen track behind that looks current.
 *
 * The endpoint (`/api/traccar/trails`) has existed and been tested since the live-GPS work; it
 * simply had no caller. Nothing new is asked of the backend here.
 */
export function useVehicleTrails(enabled: boolean): TrailFeatureCollection {
  const [trails, setTrails] = useState<TrailFeatureCollection>(EMPTY_TRAILS)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const url = `${cfg.baseUrl}${cfg.trailsPath}?minutes=${cfg.trailMinutes}`
    const stop = () => {
      if (timer.current != null) {
        window.clearInterval(timer.current)
        timer.current = null
      }
    }

    const poll = async () => {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } })
        // Same contract as the positions poll: 503 = no Traccar in this deployment, 404 = no
        // backend at all. Neither is going to fix itself, so stop rather than heartbeat.
        if (res.status === 503 || res.status === 404) {
          stop()
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: VehicleTrail[] = await res.json()
        if (!alive) return
        setTrails(trailsToGeoJSON(data))
      } catch {
        // Deliberately silent, unlike the positions poll. A missing track is a missing
        // decoration; the vehicles themselves keep their own error and staleness handling, and
        // a second error surface for the same dead Traccar would just be noise.
      }
    }

    void poll()
    timer.current = window.setInterval(poll, cfg.trailsPollMs)
    return () => {
      alive = false
      stop()
      // Clear on the way OUT rather than on the way in. Switching the layer off must not leave
      // a frozen track behind that still looks current — and doing it here instead of in the
      // effect body keeps the sync-setState-in-effect rule satisfied (on unmount React simply
      // discards the update).
      setTrails(EMPTY_TRAILS)
    }
  }, [enabled])

  return trails
}
