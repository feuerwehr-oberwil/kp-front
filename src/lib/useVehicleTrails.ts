import { useEffect, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { useFeedPoll } from './useFeedPoll'
import { TRACCAR_DEAD_STATUSES } from './useVehiclePositions'

const cfg = appConfig.gps

/** One point of a vehicle's recorded track, as the backend returns it — a GPS SAMPLE.
 *  ⚠️ NOT types.ts · `TrailPoint`, which is a Plan-board breadcrumb in board coordinates
 *  ({x, y, floor}). Both used to be exported under the name `TrailPoint`, so an import that
 *  reached for the wrong one still type-checked — against the wrong shape. */
export interface GpsTrailPoint {
  lat: number
  lng: number
  ts?: string
  course?: number | null
  speed?: number | null
}

export interface VehicleTrail {
  device_id: number
  device_name: string
  points: GpsTrailPoint[]
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

  useFeedPoll<VehicleTrail[]>({
    path: `${cfg.trailsPath}?minutes=${cfg.trailMinutes}`,
    pollMs: cfg.trailsPollMs,
    enabled,
    // same contract as the positions poll — see TRACCAR_DEAD_STATUSES
    deadStatuses: TRACCAR_DEAD_STATUSES,
    onData: (data) => setTrails(trailsToGeoJSON(data)),
    // No onError, deliberately, unlike the positions poll: a missing track is a missing
    // decoration; the vehicles themselves keep their own error and staleness handling, and a
    // second error surface for the same dead Traccar would just be noise.
  })

  useEffect(() => {
    if (!enabled) return
    // Clear on the way OUT rather than on the way in. Switching the layer off must not leave a
    // frozen track behind that still looks current — and doing it in a cleanup instead of an
    // effect body keeps the sync-setState-in-effect rule satisfied (on unmount React simply
    // discards the update).
    return () => setTrails(EMPTY_TRAILS)
  }, [enabled])

  return trails
}
