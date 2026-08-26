// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MutableRefObject } from 'react'
import type { BuildingDoc, PlanDocument } from '../types'
import { FIT_VIEW, boardViewSignature, resumeBoardView, useBoardView, type BoardView, type BoardViews } from './useBoardView'

const modul: PlanDocument = {
  id: 'm23', code: 'Modul 2-3', title: 'Angriff', subtitle: '', imageUrl: '/plans/m23.pdf',
  orientation: 'landscape',
}
const gebaeude: PlanDocument = {
  id: 'gebaeude', code: 'Gebäude', title: 'Geschosse', subtitle: '', imageUrl: '',
  orientation: 'portrait', floorStack: true,
}
const building: BuildingDoc = { ring: [[0, 0], [1, 0], [1, 1]], ringAspect: 1, floors: [0, 1], orientDeg: 12 }
const sig = (p: PlanDocument, b: BuildingDoc | null = null, s?: { mPerU: number; refM: number; ar: number }) =>
  boardViewSignature(p, b, s)
const saved = (v: Partial<BoardView> & { sig: string }): BoardView => ({ scale: 2.5, x: -120, y: 60, ...v })

// Modul 2-3 → Lage → Modul 2-3 has to land where you left it: the whole point of the memory is
// that a glance elsewhere costs nothing.
describe('resumeBoardView', () => {
  it('fits on a first visit — nothing remembered for this plan', () => {
    expect(resumeBoardView(undefined, sig(modul))).toEqual(FIT_VIEW)
  })

  it('resumes zoom AND pan when the plan still looks the same', () => {
    const s = sig(modul)
    expect(resumeBoardView(saved({ sig: s }), s)).toEqual({ scale: 2.5, x: -120, y: 60 })
  })

  it('falls back to the fit when the plan changed under the saved view', () => {
    expect(resumeBoardView(saved({ sig: sig(modul) }), sig({ ...modul, imageUrl: '/plans/m23-v2.pdf' })))
      .toEqual(FIT_VIEW)
  })
})

describe('boardViewSignature', () => {
  it('is stable for an unchanged plan — the same view keeps meaning the same thing', () => {
    expect(sig(modul)).toBe(sig({ ...modul, title: 'Anderer Titel', code: 'x' }))
  })

  it('changes when the image, the calibration or the floor stack does', () => {
    expect(sig(modul)).not.toBe(sig({ ...modul, imageUrl: '/plans/other.pdf' }))
    expect(sig(modul)).not.toBe(sig(modul, null, { mPerU: 40, refM: 10, ar: 1.4 }))
    expect(sig(gebaeude, building)).not.toBe(sig(gebaeude, { ...building, floors: [0, 1, 2] }))
    expect(sig(gebaeude, building)).not.toBe(sig(gebaeude, { ...building, northUp: true }))
  })

  it('ignores the order the storeys are stored in', () => {
    expect(sig(gebaeude, building)).toBe(sig(gebaeude, { ...building, floors: [1, 0] }))
  })
})

// …and the same rule as the hook lives it: switching plan puts the outgoing view away and takes
// the incoming one out, and a surface switch (which UNMOUNTS the Whiteboard) survives because the
// memory belongs to the caller.
describe('useBoardView · the per-plan memory', () => {
  const noCanvas: MutableRefObject<HTMLDivElement | null> = { current: null }
  const mount = (views: MutableRefObject<BoardViews>, planId: string, signature = 'sig') =>
    renderHook(
      ({ planId: p, signature: s }) => useBoardView(noCanvas, null, { views, planId: p, signature: s }),
      { initialProps: { planId, signature } },
    )

  it('keeps each plan on its own view when you switch between them', () => {
    const views: MutableRefObject<BoardViews> = { current: {} }
    const h = mount(views, 'm23')
    act(() => h.result.current.applyView(2, { x: -80, y: 40 }))

    h.rerender({ planId: 'gebaeude', signature: 'sig' }) // another plan opens fitted…
    expect(h.result.current).toMatchObject({ scale: 1, pos: { x: 0, y: 0 } })
    act(() => h.result.current.applyView(3, { x: 10, y: 10 }))

    h.rerender({ planId: 'm23', signature: 'sig' }) // …and back is back where we were
    expect(h.result.current).toMatchObject({ scale: 2, pos: { x: -80, y: 40 } })
  })

  it('resumes after the unmount a surface switch causes — Modul 2-3 → Lage → Modul 2-3', () => {
    const views: MutableRefObject<BoardViews> = { current: {} }
    const first = mount(views, 'm23')
    act(() => first.result.current.applyView(2.5, { x: -120, y: 60 }))
    first.unmount()

    const back = mount(views, 'm23')
    expect(back.result.current).toMatchObject({ scale: 2.5, pos: { x: -120, y: 60 } })
  })

  it('opens fitted when the plan changed while we were away', () => {
    const views: MutableRefObject<BoardViews> = { current: {} }
    const first = mount(views, 'm23', 'sig')
    act(() => first.result.current.applyView(2.5, { x: -120, y: 60 }))
    first.unmount()

    const back = mount(views, 'm23', 'sig-after-a-new-scan')
    expect(back.result.current).toMatchObject({ scale: 1, pos: { x: 0, y: 0 } })
  })
})
