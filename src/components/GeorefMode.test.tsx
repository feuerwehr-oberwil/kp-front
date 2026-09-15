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
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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
afterEach(() => { cleanup(); resetGeorefMode(); vi.restoreAllMocks() })

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

/**
 * ONE magnifier at a time (15.09.2026). The admin pairing stands the sheet and the map side by
 * side under a single pointer, and each half kept its own last aim — so both loupes were up at
 * once, one of them over a pane nobody was pointing at. The sheet's half of the rule: it is up
 * while the pointer is on the sheet and while the sheet has the turn, and down otherwise.
 */
it('takes the sheet’s magnifier down when the pointer leaves it or the map takes the turn', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
  const { view } = makeView()
  const board = document.createElement('div')
  vi.spyOn(board, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 500))
  view.boardRef.current = board
  view.toNorm = (x: number, y: number) => [x / 1000, y / 500]
  const loupe = () => document.body.querySelector('canvas')
  const { container, rerender } = render(<GeorefBoardLayer pairs={[]} mode={ARMED} armed sW={1000} sH={500} view={view} />)
  const capture = container.querySelector('div')!
  // hovering the sheet — the loupe is what says which pixel a tap would take
  fireEvent.pointerMove(capture, { pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 250 })
  expect(loupe()).toBeTruthy()
  // …and the pointer moves on to the map half: this one goes down before the other comes up
  // (⚠️ `pointerOut`, not `pointerLeave` — React synthesizes the leave from the out event)
  fireEvent.pointerOut(capture, { pointerId: 1, pointerType: 'mouse' })
  expect(loupe()).toBeFalsy()
  // back on the sheet, and it is the sheet's turn again
  fireEvent.pointerMove(capture, { pointerId: 1, pointerType: 'mouse', clientX: 300, clientY: 200 })
  expect(loupe()).toBeTruthy()
  // the map has the turn: no magnifier over a sheet nobody is aiming at
  rerender(<GeorefBoardLayer pairs={[]} mode={{ ...ARMED, want: 'map' }} armed sW={1000} sH={500} view={view} />)
  expect(loupe()).toBeFalsy()
})

/**
 * ONE magnifier, the same on both halves (15.09.2026). In the admin's full-screen editor the
 * sheet and the map stand side by side, so the sheet's loupe is an inset in its own PANE – the
 * map's is the same inset in its pane, and the shared rule lives in one CSS block. Portalling it
 * to the body instead would leave `position: absolute` measuring the document.
 */
it('puts the sheet’s magnifier into its own pane where both halves share one inset', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
  const { view } = makeView()
  const pane = document.body.appendChild(document.createElement('div'))
  pane.append(view.canvasEl!)
  const board = document.createElement('div')
  vi.spyOn(board, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 500))
  view.boardRef.current = board
  view.toNorm = (x: number, y: number) => [x / 1000, y / 500]
  const { container } = render(<GeorefBoardLayer pairs={[]} mode={{ ...ARMED, loupe: 'inset' }} armed sW={1000} sH={500} view={view} />)
  fireEvent.pointerMove(container.querySelector('div')!, { pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 250 })
  expect(pane.querySelector('canvas')).toBeTruthy()
  pane.remove()
})

it('repaints a stationary plan loupe when the cold PDF canvas arrives', async () => {
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
  const { view } = makeView()
  const board = document.createElement('div')
  const base = document.createElement('canvas')
  base.width = 0; base.height = 0
  board.append(base)
  const bounds = new DOMRect(100, 200, 1000, 500)
  vi.spyOn(board, 'getBoundingClientRect').mockReturnValue(bounds)
  vi.spyOn(base, 'getBoundingClientRect').mockReturnValue(bounds)
  view.boardRef.current = board
  renderCapture(view)
  const loupe = document.body.querySelector('canvas')!
  Object.defineProperties(loupe, { clientWidth: { value: 124 }, clientHeight: { value: 124 } })
  expect(drawImage).not.toHaveBeenCalled()
  // PdfViewport fills these dimensions and paints asynchronously, without changing
  // the aim or any GeorefBoardLayer prop. The inset must wake up by itself.
  base.width = 2000; base.height = 1000
  await waitFor(() => expect(drawImage).toHaveBeenCalled())
  expect(drawImage.mock.calls[drawImage.mock.calls.length - 1]?.[0]).toBe(base)
})

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
    // the REAL store this time, so a stray planTap would be visible in its slots
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
    expect(georefSnapshot().slots).toHaveLength(0)
    // …while a genuine fresh tap still places: the guard above is the pinch flag, not a dead layer
    fireEvent.pointerDown(capture, { pointerId: 3, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(capture, { pointerId: 3, clientX: 100, clientY: 100 })
    expect(georefSnapshot().slots).toHaveLength(1)
  })
})
