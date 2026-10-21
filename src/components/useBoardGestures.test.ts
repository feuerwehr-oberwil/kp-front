// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MutableRefObject, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { BoardAnno, BoardTool } from '../types'
import { useBoardGestures } from './useBoardGestures'

// The board is 200×200 client px at the origin, so a normalized 0.5/0.5 anchor projects to
// (100, 100) — the marquee's own bounds test needs a real rect (jsdom hands out zeros).
const boardRef = {
  current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }) },
} as unknown as RefObject<HTMLDivElement | null>

const ptr = (x: number, y: number): ReactPointerEvent => ({
  clientX: x, clientY: y, pointerId: 1,
  currentTarget: { setPointerCapture: () => {} },
} as unknown as ReactPointerEvent)

const setup = (annos: BoardAnno[], tool: BoardTool = 'lasso') => {
  const setSelId = vi.fn()
  const setSelIds = vi.fn()
  const setTool = vi.fn()
  const scaleRef: MutableRefObject<number> = { current: 1 }
  const posRef: MutableRefObject<{ x: number; y: number }> = { current: { x: 0, y: 0 } }
  const hook = renderHook(() => useBoardGestures({
    tool, annos, setSelId, setSelIds, setTool,
    applyView: () => {}, zoomTo: () => {}, scaleRef, posRef,
    canvasRef: { current: null }, boardRef,
    mapY: (_f, y) => y, manipMove: () => {}, manipUp: () => {},
  }))
  /** drag a box from (x0,y0) to (x1,y1) and let go — the whole lasso gesture */
  const box = (x0: number, y0: number, x1: number, y1: number) => act(() => {
    hook.result.current.stageDown(ptr(x0, y0))
    hook.result.current.stageMove(ptr(x1, y1))
    hook.result.current.stageUp()
  })
  return { box, setSelId, setSelIds, setTool }
}

const sym = (id: string, x: number, y: number): BoardAnno => ({ id, kind: 'symbol', x, y, floor: 0 })

// ── A lasso that caught exactly ONE object ──────────────────────────────────────────────────
// A group of one has no group affordances at all (groupCentroid needs two), so the Karte drops
// such a box into plain single-select — editor, grips, Löschen — and the Plan now does the same.
describe('the marquee’s single-object fallback', () => {
  it('single-selects the one anno it caught, instead of a group of one', () => {
    const { box, setSelId, setSelIds } = setup([sym('a1', 0.5, 0.5), sym('a2', 0.9, 0.9)])
    box(10, 10, 150, 150)
    expect(setSelId).toHaveBeenLastCalledWith('a1')
    expect(setSelIds).toHaveBeenLastCalledWith([])
  })

  it('hands the surface back to the selection tool — that is where the editor and grips live', () => {
    const { box, setTool } = setup([sym('a1', 0.5, 0.5)])
    box(10, 10, 150, 150)
    expect(setTool).toHaveBeenCalledWith('pan')
  })

  it('still builds a real group from two or more, and leaves the lasso armed', () => {
    const { box, setSelId, setSelIds, setTool } = setup([sym('a1', 0.25, 0.25), sym('a2', 0.5, 0.5)])
    box(10, 10, 150, 150)
    expect(setSelIds).toHaveBeenLastCalledWith(['a1', 'a2'])
    expect(setSelId).toHaveBeenLastCalledWith(null)
    expect(setTool).not.toHaveBeenCalled()
  })

  it('clears on an empty box without disarming — the next box is the obvious retry', () => {
    const { box, setSelId, setSelIds, setTool } = setup([sym('a1', 0.9, 0.9)])
    box(10, 10, 60, 60)
    expect(setSelIds).toHaveBeenLastCalledWith([])
    expect(setSelId).toHaveBeenLastCalledWith(null)
    expect(setTool).not.toHaveBeenCalled()
  })

  // locked ink is click-through everywhere else, so the lasso may not pick it up either — and
  // a box over one locked + one free object is a single catch, not a pair
  it('ignores a locked anno, so the free one beside it is the single catch', () => {
    const { box, setSelId, setTool } = setup([{ ...sym('a1', 0.25, 0.25), locked: true }, sym('a2', 0.5, 0.5)])
    box(10, 10, 150, 150)
    expect(setSelId).toHaveBeenLastCalledWith('a2')
    expect(setTool).toHaveBeenCalledWith('pan')
  })
})

// ── One-finger zoom on the board (08.10.2026) — the Karte's double tap and tap-and-drag ──────
// The grammar itself is lib/tapDragZoom's (tested there); this pins the WIRING: which tool, what
// it may not do (pan, deselect), how the pinch takes over, and that a plain drag still pans.
describe('the board’s one-finger zoom', () => {
  type Ev = { id?: number; t: number; type?: string; pointerType?: string }
  const ev = (x: number, y: number, { id = 1, t, type = 'pointerdown', pointerType = 'touch' }: Ev): ReactPointerEvent => ({
    clientX: x, clientY: y, pointerId: id, timeStamp: t, type, pointerType,
    currentTarget: { setPointerCapture: () => {} },
  } as unknown as ReactPointerEvent)

  const mount = (tool: BoardTool = 'pan') => {
    const scaleRef: MutableRefObject<number> = { current: 1 }
    const posRef: MutableRefObject<{ x: number; y: number }> = { current: { x: 0, y: 0 } }
    const applyView = vi.fn((s: number, p: { x: number; y: number }) => { scaleRef.current = s; posRef.current = p })
    // the view hook's own clamp is not under test here — apply the factor as given
    const zoomTo = vi.fn((f: number, _mx?: number, _my?: number) => { scaleRef.current *= f })
    const setSelId = vi.fn()
    const canvasRef = { current: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 600 }) } } as unknown as RefObject<HTMLDivElement | null>
    const h = renderHook(() => useBoardGestures({
      tool, annos: [], setSelId, setSelIds: vi.fn(), setTool: vi.fn(),
      applyView, zoomTo, scaleRef, posRef, canvasRef, boardRef,
      mapY: (_f, y) => y, manipMove: () => {}, manipUp: () => {},
    }))
    const g = () => h.result.current
    const down = (x: number, y: number, o: Ev) => act(() => { g().trackDown(ev(x, y, o)); g().stageDown(ev(x, y, o)) })
    const move = (x: number, y: number, o: Ev) => act(() => g().stageMove(ev(x, y, { type: 'pointermove', ...o })))
    const up = (x: number, y: number, o: Ev) => act(() => { g().trackUp(ev(x, y, { type: 'pointerup', ...o })); g().stageUp() })
    const tap = (x: number, y: number, t: number, id = 1) => { down(x, y, { id, t }); up(x, y, { id, t: t + 60 }) }
    return { down, move, up, tap, applyView, zoomTo, scaleRef, setSelId }
  }

  it('a double tap zooms ×2 about the tap, in canvas coordinates', () => {
    const b = mount()
    b.tap(110, 220, 0)
    b.tap(112, 221, 200, 2)
    expect(b.zoomTo).toHaveBeenCalledTimes(1)
    expect(b.zoomTo).toHaveBeenCalledWith(2, 100, 200) // the FIRST tap, minus the canvas origin
  })

  it('tap, then press and drag DOWN zooms in continuously — and never pans', () => {
    const b = mount()
    b.tap(110, 220, 0)
    b.down(110, 220, { id: 2, t: 200 })
    b.applyView.mockClear()
    b.move(110, 240, { id: 2, t: 220 })        // engages (×1)
    b.move(110, 240 + 128, { id: 2, t: 300 })  // one doubling further down
    expect(b.scaleRef.current).toBeCloseTo(2, 9)
    for (const c of b.zoomTo.mock.calls) expect(c.slice(1)).toEqual([100, 200])
    b.move(110, 240 - 128, { id: 2, t: 400 })  // …and back up past the start: out
    expect(b.scaleRef.current).toBeCloseTo(0.5, 9)
    const before = b.zoomTo.mock.calls.length
    b.up(110, 112, { id: 2, t: 450 })
    expect(b.zoomTo.mock.calls.length).toBe(before) // no ×2 step on release
    expect(b.applyView).not.toHaveBeenCalled() // no pan
  })

  it('the second press does not deselect again — only the first tap did', () => {
    const b = mount()
    b.tap(110, 220, 0)
    b.setSelId.mockClear()
    b.down(110, 220, { id: 2, t: 200 })
    expect(b.setSelId).not.toHaveBeenCalled()
  })

  it('a one-finger drag with no tap before it still pans', () => {
    const b = mount()
    b.down(100, 100, { t: 0 })
    b.move(100, 180, { t: 50 })
    expect(b.applyView).toHaveBeenLastCalledWith(1, { x: 0, y: 80 })
    expect(b.zoomTo).not.toHaveBeenCalled()
  })

  it('a second finger mid-drag hands over to the pinch cleanly', () => {
    const b = mount()
    b.tap(110, 220, 0)
    b.down(110, 220, { id: 2, t: 200 })
    b.move(110, 240, { id: 2, t: 220 })
    b.move(110, 300, { id: 2, t: 260 })
    const calls = b.zoomTo.mock.calls.length
    b.down(300, 300, { id: 3, t: 280 })           // pinch begins
    b.move(110, 400, { id: 2, t: 300 })           // the old finger moves: pinch maths, not tap-zoom
    const last = b.zoomTo.mock.calls[b.zoomTo.mock.calls.length - 1]
    expect(b.zoomTo.mock.calls.length).toBe(calls + 1)
    expect(last.slice(1)).not.toEqual([100, 200]) // about the fingers' midpoint, not the tap
    b.up(110, 400, { id: 2, t: 320 }); b.up(300, 300, { id: 3, t: 330 })
    // nothing left armed: a fresh press is a fresh pan
    b.applyView.mockClear()
    b.down(100, 100, { id: 4, t: 340 }); b.move(100, 150, { id: 4, t: 360 })
    expect(b.applyView).toHaveBeenCalled()
  })

  it('belongs to the selection tool only — the lasso keeps its box', () => {
    const b = mount('lasso')
    b.tap(110, 220, 0)
    b.tap(110, 220, 200, 2)
    expect(b.zoomTo).not.toHaveBeenCalled()
  })

  it('leaves the mouse alone (a double click opens editors)', () => {
    const b = mount()
    b.down(110, 220, { t: 0, pointerType: 'mouse' }); b.up(110, 220, { t: 60, pointerType: 'mouse' })
    b.down(110, 220, { t: 200, pointerType: 'mouse' }); b.up(110, 220, { t: 260, pointerType: 'mouse' })
    expect(b.zoomTo).not.toHaveBeenCalled()
  })
})
