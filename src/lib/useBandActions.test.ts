// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { useBandActions } from './useBandActions'
import type { Person, Shift, ShiftBand } from '../types'

const T = (h: number, m = 0) => `2026-07-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`
const person = (id: string): Person => ({ id, displayName: id, active: true, updatedAt: T(0) })
const früh: ShiftBand = { id: 'bd1', label: 'Früh', from: T(7), to: T(12) }

/** the hook plus the two pieces of state it drives — the surface's own wiring, in miniature */
function useHarness(initBands: ShiftBand[] = [früh], initShifts: Shift[] = []) {
  const [bands, setBands] = useState(initBands)
  const [shifts, setShifts] = useState(initShifts)
  return { bands, shifts, ...useBandActions({ bands, setBands, shifts, setShifts }) }
}

describe('creating a band', () => {
  it('writes ONE row and not a single shift', () => {
    // The rule the whole design rests on, and a sync argument as much as a UX one: if creating a
    // band wrote shifts, two devices creating the same band would each produce a full set for 66
    // people and mergeById would have to resolve duplicates of something that should never have
    // existed. An inert row cannot collide.
    const { result } = renderHook(() => useHarness([], [{ id: 'sh0', personId: 'p1', from: T(7), to: T(12) }]))
    act(() => { result.current.addBand('Früh', T(7), T(12)) })
    expect(result.current.bands).toHaveLength(1)
    expect(result.current.shifts).toEqual([{ id: 'sh0', personId: 'p1', from: T(7), to: T(12) }])
    // …and the person who already held exactly these hours freihändig is still outside the band
    expect(result.current.shifts[0].bandId).toBeUndefined()
  })
})

describe('deleting a band', () => {
  it('leaves its shifts standing as freihändige rather than cascading', () => {
    // cascading the delete would be the single path on which real planning silently disappears
    const { result } = renderHook(() => useHarness([früh], [
      { id: 'sh1', personId: 'p1', from: T(7), to: T(12), bandId: 'bd1', confirmed: true },
      { id: 'sh2', personId: 'p2', from: T(9), to: T(14) },
    ]))
    act(() => { result.current.removeBand('bd1') })
    expect(result.current.bands).toEqual([])
    expect(result.current.shifts).toHaveLength(2)
    expect(result.current.shifts[0]).toEqual({ id: 'sh1', personId: 'p1', from: T(7), to: T(12), confirmed: true })
  })
})

describe('re-timing a band', () => {
  const shifted = () => renderHook(() => useHarness([früh], [
    { id: 'sh1', personId: 'p1', from: T(7), to: T(12), bandId: 'bd1', confirmed: true },
    { id: 'sh2', personId: 'p2', from: T(9), to: T(14), bandId: 'bd1', confirmed: true }, // hatched
  ]))

  it('moves only the people who were sitting on the old window', () => {
    const { result } = shifted()
    act(() => { result.current.setBandTimes('bd1', T(8), T(13), true) })
    expect(result.current.shifts[0].from).toBe(T(8))
    // the hatched 09–14 said something specific about that person; dragging it along would
    // overwrite it with a time they never agreed to
    expect(result.current.shifts[1].from).toBe(T(9))
    expect(result.current.shifts[1].to).toBe(T(14))
  })

  it('leaves every shift where it is when the answer was «nur die Schicht»', () => {
    const { result } = shifted()
    act(() => { result.current.setBandTimes('bd1', T(8), T(13), false) })
    expect(result.current.shifts.map((s) => s.from)).toEqual([T(7), T(9)])
    expect(result.current.bands[0].from).toBe(T(8))
  })

  it('counts only the followers a move would actually drag — that is the number the question names', () => {
    const { result } = shifted()
    expect(result.current.bandFollowerCount('bd1', T(7), T(12))).toBe(1)
  })
})

describe('the cell cycle', () => {
  const p1 = person('p1')

  it('goes leer → verfügbar → eingeteilt → leer, on the band\'s own times', () => {
    const { result } = renderHook(() => useHarness())
    act(() => { result.current.cycleCell(früh, p1) })
    expect(result.current.shifts[0]).toMatchObject({ personId: 'p1', bandId: 'bd1', from: T(7), to: T(12) })
    expect(result.current.shifts[0].confirmed).toBeUndefined()
    act(() => { result.current.cycleCell(früh, p1) })
    expect(result.current.shifts[0].confirmed).toBe(true)
    act(() => { result.current.cycleCell(früh, p1) })
    expect(result.current.shifts).toEqual([])
  })

  it('never empties a hatched cell — it flips the state and keeps the hand-drawn time', () => {
    // decided 2026-07-28: the third tap of a fifty-tap sweep must not delete a stretch somebody
    // dragged by hand on the Zeitplan axis. That is the same planning Entscheid 12 protects when
    // a band is deleted, and it deserves the same protection here.
    const { result } = renderHook(() => useHarness([früh], [
      { id: 'sh1', personId: 'p1', from: T(9), to: T(14), bandId: 'bd1', confirmed: true },
    ]))
    act(() => { result.current.cycleCell(früh, p1) })
    expect(result.current.shifts[0]).toMatchObject({ from: T(9), to: T(14), confirmed: false })
    act(() => { result.current.cycleCell(früh, p1) })
    expect(result.current.shifts[0].confirmed).toBe(true)
    // round and round, never gone
    expect(result.current.shifts).toHaveLength(1)
  })

  it('fills one band without touching a person\'s cell in another', () => {
    // «Überlappende Bänder erlaubt» — leer/verfügbar may overlap freely
    const spät: ShiftBand = { id: 'bd2', label: 'Spät', from: T(10), to: T(15) }
    const { result } = renderHook(() => useHarness([früh, spät]))
    act(() => { result.current.cycleCell(früh, p1) })
    act(() => { result.current.cycleCell(spät, p1) })
    expect(result.current.shifts.map((s) => s.bandId)).toEqual(['bd1', 'bd2'])
  })
})
