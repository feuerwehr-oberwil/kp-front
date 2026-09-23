// @vitest-environment jsdom
/**
 * LOAD: the live-GPS coupling over the REAL tactical store at the size of a big Einsatz.
 *
 * 40 live vehicles, 60 Leitungen coupled to them across all three follow states, 500 other
 * objects (400 on the Karte, 100 on a georeferenced sheet), and 200 feed polls in which a few
 * vehicles move — some polls move nothing, some move only vehicles whose every coupling is paused.
 * Pinned: the store is written exactly once per poll that changed something and never otherwise,
 * no poll costs more than two renders, nothing grows without bound, and the whole run stays
 * inside a wall-clock ceiling generous enough for CI yet far below a render storm (the Übung on
 * 23.09.2026 rendered ~10 000 times in 1.5 s with ONE coupling).
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useGpsFollow } from './useGpsFollow'
import { useObjectStore } from './useObjectStore'
import { objectsFromLegacy, type PlanFit, type TacticalObject } from './tacticalObjects'
import { fitSimilarity } from './georef'
import type { BoardAnno, Drawing, Entity, GpsFollowState, LngLat } from '../types'

const VEHICLES = 40
const LINES = 60
const OTHERS_MAP = 400
const OTHERS_SHEET = 100
const TICKS = 200
const MOVERS = 4 // ~10 % of the fleet per poll
const STEP = 0.0000013 // ~0.1 m: 200 polls never carry a guarded coupling past its 20 m
const CEILING_MS = 5000

const STATES: GpsFollowState[] = ['guarded', 'continuous', 'paused']
const ORIGIN: LngLat = [7.5525, 47.5145]
const home = (v: number): LngLat => [ORIGIN[0] + (v % 8) * 0.0003, ORIGIN[1] + Math.floor(v / 8) * 0.0003]
const PLAN: PlanFit = {
  fit: fitSimilarity([
    { plan: { x: 0, y: 0 }, lngLat: { lng: ORIGIN[0], lat: ORIGIN[1] } },
    { plan: { x: 1, y: 0 }, lngLat: { lng: ORIGIN[0] + 0.0013, lat: ORIGIN[1] } },
  ] as never, 1)!,
  aspect: 1,
}
const FITS = new Map([['modul2', PLAN]])

function fixture(): TacticalObject[] {
  const lines: Drawing[] = Array.from({ length: LINES }, (_, i) => {
    const at = home(i % VEHICLES)
    return {
      id: `hose${i}`, kind: 'line', coords: [[at[0] - 0.0002, at[1] - 0.0001], at],
      endAttachment: { target: { kind: 'object', id: `gps-${i % VEHICLES}`, live: true }, routing: 'trace', gps: { state: STATES[i % 3], confirmedAt: at, lastSafe: at } },
    }
  })
  const symbols: Entity[] = Array.from({ length: OTHERS_MAP }, (_, i) => ({
    id: `sym${i}`, kind: 'symbol', layer: 'taktisch', symbol: 'VKF Feuer', coord: [ORIGIN[0] + (i % 20) * 0.0001, ORIGIN[1] + Math.floor(i / 20) * 0.0001],
  } as Entity))
  const annos: BoardAnno[] = Array.from({ length: OTHERS_SHEET }, (_, i) => ({ id: `anno${i}`, kind: 'symbol', symbol: 'VKF Feuer', x: (i % 10) / 10, y: Math.floor(i / 10) / 10 } as BoardAnno))
  return objectsFromLegacy(symbols, lines, { modul2: annos })
}

/** A deterministic poll schedule: which vehicles moved at each tick. */
function schedule(): number[][] {
  const pausedOnly = Array.from({ length: VEHICLES }, (_, v) => v)
    .filter((v) => Array.from({ length: LINES }, (_, i) => i).filter((i) => i % VEHICLES === v).every((i) => STATES[i % 3] === 'paused'))
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  return Array.from({ length: TICKS }, (_, t) => {
    if (t % 5 === 0) return [] // a poll in which nothing moved
    if (t % 7 === 0) return pausedOnly.slice(0, MOVERS) // only vehicles nobody follows right now
    const moved = new Set<number>()
    while (moved.size < MOVERS) moved.add(Math.floor(rnd() * VEHICLES))
    return [...moved]
  })
}

describe('useGpsFollow · LOAD — 40 vehicles, 60 couplings, 500 objects, 200 polls', () => {
  it('writes once per poll that changed something, renders bounded, inside the ceiling', () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a[0]) })
    const seen = { renders: 0, writes: 0, objects: null as TacticalObject[] | null, drawings: [] as Drawing[] }
    function Host({ vehicles }: { vehicles: Entity[] }) {
      seen.renders++
      const store = useObjectStore(init, false, { getFits: () => FITS, defaultLayer: 'taktisch', fitsVersion: 0 })
      if (seen.objects && store.objects !== seen.objects) seen.writes++
      seen.objects = store.objects
      seen.drawings = store.doc.drawings
      useGpsFollow({ liveVehicles: vehicles, enabled: true, setDocRaw: store.setDocRaw })
      return null
    }
    const init = fixture()
    const pos = Array.from({ length: VEHICLES }, (_, v) => home(v))
    const feed = () => pos.map((coord, v): Entity => ({ id: `gps-${v}`, kind: 'symbol', layer: 'fahrzeuge', coord: [...coord] as LngLat, live: true } as Entity))
    const followed = new Set(Array.from({ length: LINES }, (_, i) => i).filter((i) => STATES[i % 3] !== 'paused').map((i) => i % VEHICLES))
    const moves = new Array<number>(VEHICLES).fill(0)

    const started = performance.now()
    const r = render(<Host vehicles={feed()} />)
    const settled = seen.renders
    expect(seen.writes).toBe(0) // every coupling already sits on its vehicle
    let expectedWrites = 0
    let worstTick = 0
    for (const moved of schedule()) {
      for (const v of moved) { pos[v] = [pos[v][0] + STEP, pos[v][1] + STEP]; moves[v]++ }
      if (moved.some((v) => followed.has(v))) expectedWrites++
      const before = seen.renders
      act(() => r.rerender(<Host vehicles={feed()} />))
      worstTick = Math.max(worstTick, seen.renders - before)
    }
    const elapsed = performance.now() - started
    spy.mockRestore()

    expect(errors.filter((e) => /Maximum update depth|#185/.test(String(e)))).toEqual([])
    expect(expectedWrites).toBeGreaterThan(100) // the schedule really exercises the pass…
    expect(expectedWrites).toBeLessThan(TICKS) // …and really has polls that change nothing
    expect(seen.writes).toBe(expectedWrites)
    expect(worstTick).toBeLessThanOrEqual(2)
    expect(seen.renders).toBe(settled + TICKS + expectedWrites)
    expect(elapsed).toBeLessThan(CEILING_MS)

    // what the couplings say afterwards, and that nothing grew beyond what the vehicles drove
    for (let i = 0; i < LINES; i++) {
      const v = i % VEHICLES
      const d = seen.drawings.find((x) => x.id === `hose${i}`)!
      const gps = d.endAttachment!.gps!
      expect(gps.state).toBe(STATES[i % 3])
      expect(gps.lastSafe).toEqual(STATES[i % 3] === 'paused' ? home(v) : pos[v])
      expect(d.coords.length).toBeLessThanOrEqual(2 + (STATES[i % 3] === 'continuous' ? moves[v] : 0))
    }
    expect(seen.objects).toHaveLength(LINES + OTHERS_MAP + OTHERS_SHEET)
  })
})
