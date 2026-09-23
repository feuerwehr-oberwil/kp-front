// @vitest-environment jsdom
/**
 * The live-GPS coupling over the REAL tactical store (Übung 23.09.2026, post-mortem root cause A).
 *
 * A Leitung drawn onto the TLF at 18:01:06 put the iPad into a render storm one second later, and
 * every device with the vehicle feed followed: the pass rebuilt a guarded/continuous coupling on
 * every run whether or not the vehicle had moved, and ran after every render because the store's
 * `setDocRaw` was a new function each time. What is pinned: a vehicle standing still costs NO
 * write and a bounded number of renders; a vehicle moving costs exactly ONE write per sample
 * that changed something; a device that may not write the tactical document writes nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { followLiveVehicles, useGpsFollow } from './useGpsFollow'
import { useObjectStore } from './useObjectStore'
import { objectsFromLegacy, type TacticalObject } from './tacticalObjects'
import type { Drawing, Entity, GpsFollowState, LngLat } from '../types'

const TLF: LngLat = [7.5497636, 47.5229055]
/** ~0.1 m east per step at this latitude — far inside the 20 m guard for 60 steps */
const STEP = 0.0000013
const vehicle = (coord: LngLat, id = 'gps-3'): Entity => ({ id, kind: 'symbol', layer: 'fahrzeuge', coord, live: true } as Entity)
const hose = (state: GpsFollowState, id = 'hose', target = 'gps-3', at: LngLat = TLF): Drawing => ({
  id, kind: 'line', coords: [[at[0] - 0.0007, at[1] - 0.0004], at],
  endAttachment: { target: { kind: 'object', id: target, live: true }, routing: 'trace', gps: { state, confirmedAt: at, lastSafe: at } },
})

/** Mounts the store the way IncidentWorkspace does and counts what the follower costs. */
function mount(init: TacticalObject[], vehicles: Entity[], enabled = true) {
  const seen = { renders: 0, writes: 0, objects: null as TacticalObject[] | null, drawings: [] as Drawing[] }
  function Host({ vehicles, enabled }: { vehicles: Entity[]; enabled: boolean }) {
    seen.renders++
    const store = useObjectStore(init, false, { getFits: () => new Map(), defaultLayer: 'taktisch', fitsVersion: 0 })
    // a store write that changed something is a new `objects` identity; a no-op write is not
    if (seen.objects && store.objects !== seen.objects) seen.writes++
    seen.objects = store.objects
    seen.drawings = store.doc.drawings
    useGpsFollow({ liveVehicles: vehicles, enabled, setDocRaw: store.setDocRaw })
    return null
  }
  const r = render(<Host vehicles={vehicles} enabled={enabled} />)
  return { seen, feed: (next: Entity[], on = enabled) => act(() => r.rerender(<Host vehicles={next} enabled={on} />)) }
}

const noLoop = () => {
  const errors: unknown[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a[0]) })
  return () => { spy.mockRestore(); return errors.filter((e) => /Maximum update depth|#185/.test(String(e))) }
}

describe('useGpsFollow · a vehicle that does not move', () => {
  for (const state of ['guarded', 'continuous'] as const) {
    it(`${state}: no write, a bounded number of renders, no #185`, () => {
      const done = noLoop()
      const { seen, feed } = mount(objectsFromLegacy([], [hose(state)], {}), [vehicle(TLF)])
      expect(seen.renders).toBeLessThanOrEqual(3)
      expect(seen.writes).toBe(0)
      // the feed polls: a new array, new entities, the same position — ten times over
      for (let i = 0; i < 10; i++) feed([vehicle([...TLF] as LngLat)])
      expect(seen.renders).toBeLessThanOrEqual(3 + 10)
      expect(seen.writes).toBe(0)
      expect(done()).toEqual([])
    })
  }
})

describe('useGpsFollow · a vehicle that moves', () => {
  for (const state of ['guarded', 'continuous'] as const) {
    it(`${state}: exactly one store write per sample`, () => {
      const done = noLoop()
      const { seen, feed } = mount(objectsFromLegacy([], [hose(state)], {}), [vehicle(TLF)])
      const N = 25
      for (let i = 1; i <= N; i++) feed([vehicle([TLF[0] + i * STEP, TLF[1]])])
      expect(seen.writes).toBe(N)
      // one render for the sample itself, one for its write — never a third
      expect(seen.renders).toBeLessThanOrEqual(3 + 2 * N)
      const a = seen.drawings[0].endAttachment!
      expect(a.gps!.lastSafe).toEqual([TLF[0] + N * STEP, TLF[1]])
      expect(a.gps!.state).toBe(state)
      if (state === 'continuous') expect(seen.drawings[0].coords[seen.drawings[0].coords.length - 1]).toEqual([TLF[0] + N * STEP, TLF[1]])
      expect(done()).toEqual([])
    })
  }

  it('guarded: the sample past 20 m pauses the coupling once, and nothing is written after it', () => {
    const { seen, feed } = mount(objectsFromLegacy([], [hose('guarded')], {}), [vehicle(TLF)])
    feed([vehicle([TLF[0] + 0.0004, TLF[1]])]) // ~30 m
    expect(seen.writes).toBe(1)
    expect(seen.drawings[0].endAttachment!.gps!.state).toBe('paused')
    for (let i = 2; i <= 5; i++) feed([vehicle([TLF[0] + i * 0.0004, TLF[1]])])
    expect(seen.writes).toBe(1)
  })

  it('a device that may not write the tactical document writes nothing, however far it drives', () => {
    const { seen, feed } = mount(objectsFromLegacy([], [hose('continuous')], {}), [vehicle(TLF)], false)
    for (let i = 1; i <= 10; i++) feed([vehicle([TLF[0] + i * STEP, TLF[1]])])
    expect(seen.writes).toBe(0)
    // …and it catches up in ONE write the moment it may
    feed([vehicle([TLF[0] + 10 * STEP, TLF[1]])], true)
    expect(seen.writes).toBe(1)
  })
})

describe('followLiveVehicles · the pass itself', () => {
  const doc = (d: Drawing[]) => ({ entities: [], drawings: d })

  it('returns the SAME document when nothing changed by value', () => {
    for (const state of ['guarded', 'continuous', 'paused'] as const) {
      const cur = doc([hose(state)])
      expect(followLiveVehicles(cur, [vehicle([...TLF] as LngLat)])).toBe(cur)
    }
  })

  it('ignores a vehicle missing from the feed and a line that is not live-coupled', () => {
    const plain: Drawing = { id: 'x', kind: 'line', coords: [[7.5, 47.5], [7.6, 47.6]] }
    const cur = doc([hose('continuous'), plain])
    expect(followLiveVehicles(cur, [vehicle([TLF[0] + STEP, TLF[1]], 'gps-other')])).toBe(cur)
  })

  it('keeps every untouched drawing by identity when one moves', () => {
    const other = hose('guarded', 'other', 'gps-9')
    const cur = doc([hose('continuous'), other])
    const next = followLiveVehicles(cur, [vehicle([TLF[0] + STEP, TLF[1]]), vehicle(TLF, 'gps-9')])
    expect(next).not.toBe(cur)
    expect(next.drawings[1]).toBe(other)
  })
})
