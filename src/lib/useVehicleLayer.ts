import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { useVehiclePositions, vehicleSymbolSvg } from './useVehiclePositions'
import type { Entity, LngLat } from '../types'

// Live-vehicle layer, extracted from App's god component. The GPS list is derived from
// the backend each poll (never persisted); operator overrides (drag to reposition / orient)
// ride the workspace blob and win over the live value until reset.

export type VehicleOverrides = Record<string, { coord?: LngLat; rotation?: number }>

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
    }
  }), [gps.vehicles, overrides])
  const liveIds = useMemo(() => new Set(gps.vehicles.map((v) => v.id)), [gps.vehicles])

  return { gpsVehicles: gps.vehicles, liveVehicles, liveIds, overrides, setOverrides }
}
