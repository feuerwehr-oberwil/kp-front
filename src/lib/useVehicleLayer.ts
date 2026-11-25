import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { useVehiclePositions, vehicleSymbolSvg } from './useVehiclePositions'
import { appConfig } from '../config/appConfig'
import type { Entity, LngLat } from '../types'

// Live-vehicle layer, extracted from App's god component. The GPS list is derived from
// the backend each poll (never persisted); operator overrides (drag to reposition / orient)
// ride the workspace blob and win over the live value until reset.

/** Per-vehicle operator overrides, persisted in the workspace blob. `fahrer` and `herkunft` are
 *  here rather than in the entity's own fields because a live vehicle is REBUILT from the GPS feed
 *  on every poll — anything written onto the entity itself would be gone within seconds. Merged
 *  per field (mergeWorkspace · MERGE_POLICY.vehicleOverrides): one device naming the Fahrer while
 *  another sets the Herkunft keeps both. */
export type VehicleOverrides = Record<string, { coord?: LngLat; rotation?: number; fahrer?: string; herkunft?: string }>

/** The part of a vehicle's override a hand placed: where it stands and where it points. */
export type VehiclePosition = Pick<VehicleOverrides[string], 'coord' | 'rotation'>

/** The hand position of a vehicle, or null while it follows its GPS — what «Zurück auf GPS» is
 *  offered for. A heading of 0 counts; a Fahrer or a Herkunft alone does not. */
export function positionOverride(ov: VehicleOverrides[string] | undefined): VehiclePosition | null {
  if (ov?.coord == null && ov?.rotation == null) return null
  return { ...(ov.coord != null ? { coord: ov.coord } : {}), ...(ov.rotation != null ? { rotation: ov.rotation } : {}) }
}

/**
 * A vehicle's hand position written into the overrides; `null` puts it back on its GPS. The
 * Fahrer and the Herkunft stay, and a row left empty goes.
 * ⚠️ The reset used to drop the WHOLE row, Fahrer and Herkunft with it (hunt 24.11.2026,
 * frontend-state F4).
 */
export function withVehiclePosition(m: VehicleOverrides, id: string, pos: VehiclePosition | null): VehicleOverrides {
  const { coord: _coord, rotation: _rotation, ...rest } = m[id] ?? {}
  const row = { ...rest, ...pos }
  if (Object.values(row).every((v) => v === undefined)) {
    const { [id]: _drop, ...others } = m
    return others
  }
  return { ...m, [id]: row }
}

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

/** The feed's fields plus the operator's Fahrer and Herkunft (a blank one adds nothing). */
export function withOverrideFields(fields: Entity['fields'], ov: VehicleOverrides[string]): Entity['fields'] {
  const fahrer = ov.fahrer?.trim(), herkunft = ov.herkunft?.trim()
  if (!fahrer && !herkunft) return fields
  return {
    ...fields,
    ...(fahrer ? { Fahrer: fahrer } : {}),
    ...(herkunft ? { [appConfig.symbols.originField]: herkunft } : {}),
  }
}

/** `live` false: no GPS poll at all (useVehiclePositions · enabled) – the overrides still load */
export function useVehicleLayer(initOverrides: VehicleOverrides, live = true): VehicleLayer {
  const gps = useVehiclePositions(live)
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
      // the Fahrer and the Herkunft join the feed's own readings, so they show on the symbol
      // caption and print on the Kroki exactly like a placed vehicle's do
      fields: withOverrideFields(v.fields, ov),
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
