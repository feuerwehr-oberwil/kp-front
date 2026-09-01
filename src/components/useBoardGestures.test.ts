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
