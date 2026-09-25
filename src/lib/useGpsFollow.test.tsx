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
import { useMapDrawing } from './useMapDrawing'
import { routingPatch } from './gpsReturn'
import { resolveMapDrawings } from './lineAttachments'
import { mergeWorkspace } from './mergeWorkspace'
import { haversineM } from './geo'
import type { Drawing, Entity, GpsFollowState, LngLat } from '../types'

const TLF: LngLat = [8.0, 47.0] // a neutral point — no station's real place
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

/**
 * D3 (24.09.2026) over the REAL store, the way the Übung went: a hose coupled to the TLF, the TLF
 * drives off (the coupling pauses), «Weiter folgen» is tapped, the TLF drives to the Magazin —
 * and «Zurück auf Stand am Einsatzort» has to put the line back as it stood, as ONE undo step,
 * with the snapshot surviving every follower write, the sync merge and ↶/↷.
 */
describe('useGpsFollow · «Weiter folgen» keeps the way back (D3)', () => {
  const SITE = TLF
  const DEPOT: LngLat = [TLF[0] + 0.0100, TLF[1] + 0.0070] // ~1.1 km
  const path = (from: LngLat, to: LngLat, n: number): LngLat[] =>
    Array.from({ length: n }, (_, i) => [from[0] + ((to[0] - from[0]) * (i + 1)) / n, from[1] + ((to[1] - from[1]) * (i + 1)) / n + (i % 2 ? 0.00004 : 0)])
  const reach = (coords: LngLat[]) => Math.max(...coords.map((p) => haversineM(SITE, p)))

  function mountWithEditor(init: TacticalObject[], vehicles: Entity[]) {
    const seen = {
      drawings: [] as Drawing[],
      log: vi.fn(),
      emit: vi.fn(),
      api: null as null | { store: ReturnType<typeof useObjectStore>; drawing: ReturnType<typeof useMapDrawing> },
    }
    function Host({ vehicles }: { vehicles: Entity[] }) {
      const store = useObjectStore(init, false, { getFits: () => new Map(), defaultLayer: 'taktisch', fitsVersion: 0 })
      const drawing = useMapDrawing({
        drawings: store.doc.drawings, selectedDrawingId: null, tacticalLocked: false, tool: 'select', setTool: () => {},
        commit: store.commit, setDocRaw: store.setDocRaw, beginDrag: store.beginDrag, endDrag: store.endDrag,
        emit: seen.emit, log: seen.log,
        setSelectedDrawingId: () => {}, setSelectedId: () => {}, setSelectedDrawIds: () => {}, setSelectedEntityIds: () => {},
      })
      seen.drawings = store.doc.drawings
      seen.api = { store, drawing }
      useGpsFollow({ liveVehicles: vehicles, enabled: true, setDocRaw: store.setDocRaw })
      return null
    }
    const r = render(<Host vehicles={vehicles} />)
    return { seen, feed: (next: Entity[]) => act(() => r.rerender(<Host vehicles={next} />)) }
  }

  it('drive-off → «Weiter folgen» → Magazin → «Zurück»: the on-site line, one ↶ step, no spike', () => {
    const start = hose('guarded')
    const { seen, feed } = mountWithEditor(objectsFromLegacy([], [start], {}), [vehicle(SITE)])
    // the TLF drives off: past 20 m the coupling pauses and the end stays on site
    const away = path(SITE, DEPOT, 30)
    feed([vehicle(away[2])])
    expect(seen.drawings[0].endAttachment!.gps!.state).toBe('paused')
    // «Weiter folgen» (IncidentWorkspace · setGpsRouting)
    const d0 = seen.drawings[0]
    act(() => { seen.api!.drawing.patchDrawingById(d0.id, routingPatch(d0, 'end', 'trace', { resolvedEnd: d0.coords[d0.coords.length - 1], at: '2026-09-23T20:31:00.000Z' })!) })
    const before = seen.drawings[0].endAttachment!.gps!.before!
    expect(before.coords).toEqual(start.coords)
    // …to the Magazin: every sample is a machine write, and the snapshot rides along untouched
    for (const p of away.slice(3)) feed([vehicle(p)])
    const followed = seen.drawings[0]
    expect(followed.endAttachment!.gps!.before).toEqual(before)
    expect(reach(followed.coords)).toBeGreaterThan(1000)
    // «Zurück auf Stand am Einsatzort»
    let ok = false
    act(() => { ok = seen.api!.drawing.revertGpsFollow(followed.id, 'end', 'Leitung: zurück') })
    expect(ok).toBe(true)
    expect(seen.drawings[0].coords).toEqual(start.coords)
    expect(seen.drawings[0].endAttachment).toBeUndefined()
    expect(reach(resolveMapDrawings(seen.drawings, [vehicle(DEPOT)])[0].coords)).toBeLessThan(100)
    expect(seen.log).toHaveBeenCalledTimes(1)
    // the feed keeps polling: a detached line is nobody's to move
    const drawingsNow = seen.drawings
    feed([vehicle(SITE)])
    expect(seen.drawings).toBe(drawingsNow)
    // ONE ↶ gives the followed line back — drive, coupling and snapshot — and ↷ takes it again
    act(() => { seen.api!.store.undo() })
    expect(seen.drawings[0].endAttachment!.gps!.state).toBe('continuous')
    expect(seen.drawings[0].endAttachment!.gps!.before).toEqual(before)
    act(() => { seen.api!.store.redo() })
    expect(seen.drawings[0].coords).toEqual(start.coords)
    expect(seen.drawings[0].endAttachment).toBeUndefined()
  })

  it('the snapshot survives the three-way sync merge, from either side and from a views-only blob', () => {
    const paused = hose('paused')
    const followed: Drawing = { ...paused, ...routingPatch(paused, 'end', 'trace', { resolvedEnd: TLF, at: '2026-09-23T20:31:00.000Z' })! }
    const other: Entity = { id: 'sym', kind: 'symbol', layer: 'taktisch', symbol: 'VKF Feuer', coord: [8.002, 47.001] } as Entity
    const base = { objects: objectsFromLegacy([], [paused], {}) }
    const snap = followed.endAttachment!.gps!.before
    const snapOf = (ws: Record<string, unknown>) => (ws.drawings as Drawing[]).find((d) => d.id === 'hose')!.endAttachment!.gps!.before
    // I followed, the server has another device's new symbol
    const mine = { objects: objectsFromLegacy([], [followed], {}) }
    expect(snapOf(mergeWorkspace(base, mine, { objects: objectsFromLegacy([other], [paused], {}) }))).toEqual(snap)
    // another device followed, I only placed a symbol
    expect(snapOf(mergeWorkspace(base, { objects: objectsFromLegacy([other], [paused], {}) }, mine))).toEqual(snap)
    // an older build saves VIEWS only — the field it does not know is still in the drawing it saved
    expect(snapOf(mergeWorkspace(base, { drawings: [followed] }, base))).toEqual(snap)
  })
})
