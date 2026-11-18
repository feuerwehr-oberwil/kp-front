// The bond is decided by pixel distance and carried by coordinate deltas — both of which fail
// silently when wrong (a placard that "just doesn't dock", a pair that drifts apart). These pin
// the host rules, the drop radius and the carry arithmetic.

import { describe, expect, it } from 'vitest'
import type { Entity, LngLat } from '../types'
import { appConfig } from '../config/appConfig'
import { DOCK_RADIUS_PX, DOCK_SLOT_STEP_PX, DOCK_TETHER_PX, TEAM_DOCK_RADIUS_PX, carryDocked, dockRadiusFor, dockRingPx, dockSlotOffset, dockSlots, isDockHost, isDockable, nearestDockHost, teamDockHost } from './docking'

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

describe('isDockable', () => {
  it('a placard and a team marker dock; a plain symbol never does', () => {
    expect(isDockable(placard)).toBe(true)
    expect(isDockable({ id: 't', kind: 'team', layer: 'taktisch', coord: [0, 0], label: 'Trupp 1' })).toBe(true)
    expect(isDockable(tank)).toBe(false)
    expect(isDockable(undefined)).toBe(false)
  })
})

describe('nearestDockHost', () => {
  it('finds the nearest dockable entity inside the drop radius, and nothing outside it', () => {
    const near: LngLat = [DOCK_RADIUS_PX / 2000, 0]
    const far: LngLat = [(DOCK_RADIUS_PX + 10) / 1000, 0]
    expect(nearestDockHost(near, [tank], project)?.id).toBe('tank')
    expect(nearestDockHost(far, [tank], project)).toBeNull()
  })

  // a Trupp pill's anchor dot sits two glyph widths from the symbol it was parked beside
  it('a team marker docks from farther away than a placard', () => {
    const team: Entity = { id: 't', kind: 'team', layer: 'taktisch', coord: [0, 0], label: 'Trupp 1' }
    const parked: LngLat = [(DOCK_RADIUS_PX + 20) / 1000, 0]
    expect(dockRadiusFor(team)).toBe(TEAM_DOCK_RADIUS_PX)
    expect(nearestDockHost(parked, [tank], project, dockRadiusFor(placard))).toBeNull()
    expect(nearestDockHost(parked, [tank], project, dockRadiusFor(team))?.id).toBe('tank')
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

// ── Der Platz neben dem Symbol (M2 C, owner pick 18.11.2026) ──────────────────────────────
// A docked Trupp marker is drawn at ONE place: right of its host tile, one tether beyond the ring
// round it, and several stack DOWNWARDS from the tile's middle. Both halves of the map read these
// numbers: MapMarkers offsets the marker (and its tether), MapView's label pass books the box.
describe('dockSlotOffset (where a docked Trupp marker\'s dot is drawn)', () => {
  it('puts the first one beside the tile, on its middle row, a tether beyond the ring', () => {
    expect(dockSlotOffset(40, 0)).toEqual({ dx: dockRingPx(40) + DOCK_TETHER_PX + 8, dy: 0 })
  })

  it('the ring clears the corners of a square tile (half its diagonal, less a rounded corner)', () => {
    for (const px of [28, 40, 48]) expect(dockRingPx(px)).toBeGreaterThan(Math.SQRT2 * (px / 2 - 6) + 6)
  })

  it('stacks the next ones DOWNWARDS, one plate apart, on the same column', () => {
    const three = [0, 1, 2].map((i) => dockSlotOffset(40, i))
    expect(new Set(three.map((s) => s.dx)).size).toBe(1)
    expect(three.map((s) => s.dy)).toEqual([0, DOCK_SLOT_STEP_PX, 2 * DOCK_SLOT_STEP_PX])
  })

  it('tracks the glyph: a bigger tile pushes the slot out with it', () => {
    expect(dockSlotOffset(48, 0).dx).toBeGreaterThan(dockSlotOffset(40, 0).dx)
  })
})

describe('dockSlots (which Trupp marker sits in which slot)', () => {
  const team = (id: string, dockedTo?: string): Entity =>
    ({ id, kind: 'team', layer: 'taktisch', coord: [0, 0], label: id, dockedTo }) as Entity

  it('numbers each host\'s stack from the top, by id — never by array order', () => {
    // a sync that re-orders the array must not re-shuffle the stack: a marker that swapped
    // slots between two frames would read as the crew moving
    const slots = dockSlots([team('b', 'tank'), team('a', 'tank'), team('c', 'other')])
    expect(slots.get('a')).toBe(0)
    expect(slots.get('b')).toBe(1)
    expect(slots.get('c')).toBe(0)
  })

  it('ignores a loose marker and a docked PLACARD — only Trupp markers take a slot', () => {
    expect(dockSlots([team('loose'), placard, tank]).size).toBe(0)
  })
})

describe('teamDockHost (what a docked Trupp marker hangs on)', () => {
  const team = (dockedTo?: string): Entity =>
    ({ id: 't', kind: 'team', layer: 'taktisch', coord: [0.001, 0], label: 'Frei Nina', dockedTo }) as Entity

  it('is the host for a docked Trupp, and nothing for a loose one or a docked placard', () => {
    expect(teamDockHost(team('tank'), [tank])?.id).toBe('tank')
    expect(teamDockHost(team(), [tank])).toBeNull()
    expect(teamDockHost(placard, [tank])).toBeNull()
  })

  it('is nothing when the host is gone – the marker just stands on its point, untethered', () => {
    expect(teamDockHost(team('tank'), [])).toBeNull()
  })
})
