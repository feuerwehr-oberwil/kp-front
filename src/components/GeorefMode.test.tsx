// @vitest-environment jsdom
/**
 * The pinch-then-pan gesture on the georef capture layer (GeorefBoardLayer).
 *
 * ⚠️ Regression for the post-pinch jump (29.08.): `down()` snapshots the board's position once,
 * but a pinch keeps moving the board through `zoomTo`. When the second finger lifted, the
 * surviving finger's `move()` panned on from the STALE pre-pinch origin — the sheet, crosses and
 * all, snapped back on the very first sample. `up()` now re-baselines the gesture onto the
 * current view and the surviving pointer, which is exactly what these tests pin.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { GeorefBoardLayer, type PlanViewApi } from './GeorefMode'
import { GEOREF_OFF, georefDispatch, georefSnapshot, resetGeorefMode, type GeorefModeState } from '../lib/georefMode'

beforeAll(() => {
  // jsdom has neither pointer capture nor a layout engine — the capture layer needs both stubs
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(() => { cleanup(); resetGeorefMode() })

const ARMED: GeorefModeState = { ...GEOREF_OFF, planId: 'modul2', want: 'plan' }

/** A PlanViewApi whose zoomTo MOVES the board — the premise of the stale-origin bug. */
const makeView = () => {
  const scaleRef = { current: 1 }
  const posRef = { current: { x: 0, y: 0 } }
  const applyView = vi.fn((scale: number, pos: { x: number; y: number }) => {
    scaleRef.current = scale; posRef.current = pos
  })
  const zoomTo = vi.fn(() => { scaleRef.current = 2; posRef.current = { x: -50, y: -30 } })
  const view: PlanViewApi = {
    toNorm: () => null,
    applyView, zoomTo, scaleRef, posRef,
    canvasEl: document.createElement('div'),
    boardRef: { current: null },
  }
  return { view, applyView, zoomTo }
}

const renderCapture = (view: PlanViewApi) => {
  const { container } = render(
    <GeorefBoardLayer pairs={[]} mode={ARMED} armed sW={1000} sH={500} view={view} />,
  )
  // with no pairs, no queue and no aim, the capture overlay is the component's only element
  return container.querySelector('div')!
}

describe('the capture layer after a pinch ends', () => {
  it('pans on from the post-pinch board position, not the pre-pinch snapshot', () => {
    const { view, applyView, zoomTo } = makeView()
    const capture = renderCapture(view)
    // finger 1 down → the gesture snapshots the board at (0,0)
    fireEvent.pointerDown(capture, { pointerId: 1, clientX: 100, clientY: 100 })
    // finger 2 joins → pinch; the board zooms AND moves under both fingers
    fireEvent.pointerDown(capture, { pointerId: 2, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(capture, { pointerId: 2, clientX: 300, clientY: 100 })
    expect(zoomTo).toHaveBeenCalled() // the board now stands at (-50,-30), scale 2
    // finger 2 lifts → the gesture must re-baseline onto the moved board
    fireEvent.pointerUp(capture, { pointerId: 2, clientX: 300, clientY: 100 })
    // finger 1 pans on, +30px past the slop: the pan continues from (-50,-30) —
    // the stale origin would have snapped the sheet to (30,0)
    fireEvent.pointerMove(capture, { pointerId: 1, clientX: 130, clientY: 100 })
    expect(applyView).toHaveBeenLastCalledWith(2, { x: -20, y: -30 })
  })

  it('never turns the surviving finger’s release into a placement', () => {
    // the REAL store this time, so a stray planTap would be visible in its queue
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: 2 })
    const { view } = makeView()
    view.toNorm = () => [0.5, 0.5] // every release is ON the sheet — only the multi flag protects
    const capture = renderCapture(view)
    fireEvent.pointerDown(capture, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerDown(capture, { pointerId: 2, clientX: 200, clientY: 100 })
    fireEvent.pointerUp(capture, { pointerId: 2, clientX: 200, clientY: 100 })
    // a gesture that was ever a pinch is `multi` for good — lifting the first finger without
    // further travel must not read as a tap
    fireEvent.pointerUp(capture, { pointerId: 1, clientX: 100, clientY: 100 })
    expect(georefSnapshot().queue).toHaveLength(0)
    // …while a genuine fresh tap still places: the guard above is the pinch flag, not a dead layer
    fireEvent.pointerDown(capture, { pointerId: 3, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(capture, { pointerId: 3, clientX: 100, clientY: 100 })
    expect(georefSnapshot().queue).toHaveLength(1)
  })
})
