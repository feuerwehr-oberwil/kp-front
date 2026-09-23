// @vitest-environment jsdom
/**
 * The tapped Trupp's pill under a store that keeps updating (Übung 23.09.2026, post-mortem A1).
 *
 * The pill measures where its action bar landed after every render. It used to hand React a
 * state update on every one of those passes — a no-op updater, but one React still had to
 * schedule and render — and inside the live-GPS render storm that was the update which tipped
 * React's nested-update counter: #185 was thrown in the pill and the Karte went down under the
 * operator's finger. What is pinned: a re-render of the pill's host costs the pill ONE render,
 * never two, and a store churning under an open pill neither throws nor multiplies renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { TwinTeamPill } from './TwinTeamPill'
import { useObjectStore } from '../lib/useObjectStore'
import { useGpsFollow } from '../lib/useGpsFollow'
import { objectsFromLegacy } from '../lib/tacticalObjects'
import type { Drawing, Entity, LngLat, Trupp } from '../types'

afterEach(cleanup)

const TRUPPS: Trupp[] = [{ id: 't1', no: 2, name: 'Meier Anna', status: 'raus', members: [], readings: [] } as unknown as Trupp]
const TLF: LngLat = [7.5497636, 47.5229055]
const vehicle = (coord: LngLat): Entity => ({ id: 'gps-3', kind: 'symbol', layer: 'fahrzeuge', coord, live: true } as Entity)
const hose = (state: 'guarded' | 'continuous'): Drawing => ({
  id: 'hose', kind: 'line', coords: [[7.5490, 47.5225], TLF],
  endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'trace', gps: { state, confirmedAt: TLF, lastSafe: TLF } },
})

function Pill() {
  return (
    <div className="marker">
      <TwinTeamPill name="Meier Anna" color="#c00" raus truppId="t1" floor={1} trailCount={0} trailShown trupps={TRUPPS}
        acts={{ rename: () => {}, pick: () => {}, mark: () => {}, clearTrail: () => {}, remove: () => {}, toggleTrail: () => {} }} />
    </div>
  )
}

describe('TwinTeamPill · its bar placement is not an update of its own', () => {
  it('a host re-render costs the pill exactly one render', () => {
    let pillRenders = 0
    function Host({ n }: { n: number }) {
      return <Profiler id="pill" onRender={() => { pillRenders++ }}><span data-n={n} /><Pill /></Profiler>
    }
    const r = render(<Host n={0} />)
    const settled = pillRenders // mount + the one pass that learns the first real placement
    for (let i = 1; i <= 100; i++) act(() => r.rerender(<Host n={i} />))
    expect(pillRenders - settled).toBe(100)
  })

  for (const state of ['guarded', 'continuous'] as const) {
    it(`stays open under a ${state} live-GPS store that updates on every sample, without #185`, () => {
      const errors: unknown[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a[0]) })
      let hostRenders = 0
      let pillRenders = 0
      function Host({ vehicles }: { vehicles: Entity[] }) {
        hostRenders++
        const store = useObjectStore(objectsFromLegacy([], [hose(state)], {}), false, { getFits: () => new Map(), defaultLayer: 'taktisch', fitsVersion: 0 })
        useGpsFollow({ liveVehicles: vehicles, enabled: true, setDocRaw: store.setDocRaw })
        return <Profiler id="pill" onRender={() => { pillRenders++ }}><Pill /></Profiler>
      }
      const r = render(<Host vehicles={[vehicle(TLF)]} />)
      // 60 samples, the vehicle creeping 0.1 m per sample: every one is a real store write
      for (let i = 1; i <= 60; i++) {
        act(() => r.rerender(<Host vehicles={[vehicle([TLF[0] + i * 0.0000013, TLF[1]])]} />))
      }
      spy.mockRestore()
      expect(errors.filter((e) => String(e).includes('Maximum update depth'))).toEqual([])
      expect(r.container.querySelector('.wb-resource-pill')).toBeTruthy()
      // mount + 60 samples, each at most one follow-up render for its one write
      expect(hostRenders).toBeLessThanOrEqual(1 + 60 * 2 + 1)
      // …and the pill renders with its host, never more
      expect(pillRenders).toBeLessThanOrEqual(hostRenders + 1)
    })
  }
})
