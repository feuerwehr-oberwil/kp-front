// The bond is decided by pixel distance and carried by coordinate deltas — both of which fail
// silently when wrong (a placard that "just doesn't dock", a pair that drifts apart). These pin
// the host rules, the drop radius and the carry arithmetic.

import { describe, expect, it } from 'vitest'
import type { Entity, LngLat } from '../types'
import { appConfig } from '../config/appConfig'
import { DOCK_RADIUS_PX, carryDocked, isDockHost, nearestDockHost } from './docking'

// a fake projection: 1° = 1000 px, so pixel thresholds are easy to stage
const project = (c: LngLat) => ({ x: c[0] * 1000, y: c[1] * 1000 })

const tank: Entity = { id: 'tank', kind: 'symbol', layer: 'taktisch', coord: [0, 0], symbol: 'VKF Feuer', label: 'Tank' }
const placard: Entity = {
  id: 'p1', kind: 'symbol', layer: 'taktisch', coord: [0.02, 0],
  symbol: appConfig.symbols.placardName, fields: { 'UN-Nr.': '1203' }, dockedTo: 'tank',
}

describe('isDockHost', () => {
  it('symbols and parked vehicles host; live vehicles and other placards never do', () => {
    expect(isDockHost(tank)).toBe(true)
    expect(isDockHost({ ...tank, kind: 'vehicle' })).toBe(true)
    expect(isDockHost({ ...tank, kind: 'vehicle', live: true })).toBe(false)
    expect(isDockHost({ ...placard, dockedTo: undefined })).toBe(false)
  })
})

describe('nearestDockHost', () => {
  it('finds the nearest dockable entity inside the drop radius, and nothing outside it', () => {
    const near: LngLat = [DOCK_RADIUS_PX / 2000, 0]
    const far: LngLat = [(DOCK_RADIUS_PX + 10) / 1000, 0]
    expect(nearestDockHost(near, [tank], project)?.id).toBe('tank')
    expect(nearestDockHost(far, [tank], project)).toBeNull()
  })

  it('never offers an undockable entity, however close', () => {
    const loosePlacard = { ...placard, dockedTo: undefined }
    expect(nearestDockHost([0.001, 0], [loosePlacard], project)).toBeNull()
  })
})

describe('carryDocked', () => {
  it('shifts a docked placard by the host delta, preserving the chosen offset', () => {
    const out = carryDocked([tank, placard], 'tank', [0, 0], [0.5, 0.25])
    expect(out.find((e) => e.id === 'p1')?.coord).toEqual([0.52, 0.25])
  })

  it('leaves undocked entities and other hosts alone', () => {
    const loose = { ...placard, id: 'p2', dockedTo: undefined }
    const out = carryDocked([tank, placard, loose], 'other-host', [0, 0], [1, 1])
    expect(out.find((e) => e.id === 'p1')?.coord).toEqual([0.02, 0])
    expect(out.find((e) => e.id === 'p2')?.coord).toEqual([0.02, 0])
  })
})
