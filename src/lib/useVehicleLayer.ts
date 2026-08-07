import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { useVehiclePositions, vehicleSymbolSvg } from './useVehiclePositions'
import type { Entity, LngLat } from '../types'

// Live-vehicle layer, extracted from App's god component. The GPS list is derived from
// the backend each poll (never persisted); operator overrides (drag to reposition / orient)
// ride the workspace blob and win over the live value until reset.

/** Per-vehicle operator overrides, persisted in the workspace blob. `fahrer` is here rather
 *  than in the entity's own fields because a live vehicle is REBUILT from the GPS feed on every
 *  poll — anything written onto the entity itself would be gone within seconds. */
export type VehicleOverrides = Record<string, { coord?: LngLat; rotation?: number; fahrer?: string }>

export interface VehicleLayer {
  /** raw live GPS entities from the backend (drives the "live" map badge) */
  gpsVehicles: Entity[]
  /** live vehicles with operator overrides (position/rotation) applied */
  liveVehicles: Entity[]
  /** ids of all live (GPS-backed) vehicles — distinguishes them from placed objects */
  liveIds: Set<string>
  /** per-vehicle operator overrides — persisted in the workspace blob */
  overrides: VehicleOverrides
  setOverrides: Dispatch<SetStateAction<VehicleOverrides>>
  /**
   * The live feed has gone silent and the vehicles on screen are frozen at their last
   * known positions. Previously `gps.error` was dropped here entirely, so a dead Traccar
   * feed was indistinguishable from a stationary fleet — the symbols just stopped moving.
   */
  gpsStale: boolean
  /** Age of the last successful GPS poll in ms; null before the first one. */
  gpsAgeMs: number | null
}

export function useVehicleLayer(initOverrides: VehicleOverrides): VehicleLayer {
  const gps = useVehiclePositions()
  const [overrides, setOverrides] = useState<VehicleOverrides>(initOverrides)

  const liveVehicles = useMemo(() => gps.vehicles.map((v) => {
    const ov = overrides[v.id]
    if (!ov) return v
    const rotation = ov.rotation ?? v.rotation
    return {
      ...v,
      coord: ov.coord ?? v.coord,
      rotation,
      symbolSvg: ov.rotation != null ? vehicleSymbolSvg(v.label ?? '', rotation ?? 0) : v.symbolSvg,
      // aiming a vehicle by hand IS stating a direction — the rebuilt glyph gets the arrow
      directed: ov.rotation != null ? true : v.directed,
      // the Fahrer joins the feed's own readings, so it shows on the symbol caption and prints
      // on the Kroki exactly like a placed vehicle's Fahrer does
      fields: ov.fahrer?.trim() ? { ...v.fields, Fahrer: ov.fahrer.trim() } : v.fields,
    }
  }), [gps.vehicles, overrides])
  const liveIds = useMemo(() => new Set(gps.vehicles.map((v) => v.id)), [gps.vehicles])

  return {
    gpsVehicles: gps.vehicles,
    liveVehicles,
    liveIds,
    overrides,
    setOverrides,
    gpsStale: gps.stale,
    gpsAgeMs: gps.ageMs,
  }
}
