// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WbVertexHandles } from './WbControls'
import { appConfig } from '../config/appConfig'
import { MAX_VERTEX_HANDLES } from '../lib/lineStyle'
import type { BoardAnno, BoardPoint } from '../types'

afterEach(cleanup)

const WB = appConfig.copy.whiteboard
const M = appConfig.copy.measure
// board px: a 1000×1000 stage, identity floor map (single sheet)
const stage = { sW: 1000, sH: 1000, mapY: (_f: number | undefined, ly: number) => ly }
const noop = () => {}
const handlers = { onVertexDown: noop, onInsert: noop, onDeleteVertex: noop }

/** a horizontal stroke of `n` points spread over the full board width */
const stroke = (n: number): BoardAnno => ({
  id: 'l1', kind: 'draw', floor: 0,
  pts: Array.from({ length: n }, (_, i): BoardPoint => [i / (n - 1), 0.5, 0]),
})

const grips = () => screen.queryAllByRole('button', { name: WB.dragVertex })
const plusses = () => screen.queryAllByRole('button', { name: WB.insertVertex })

describe('WbVertexHandles · the vertex-handle cap degrades instead of switching off', () => {
  it('gives an ordinary node line a grip and a «+» per segment', () => {
    render(<WbVertexHandles anno={stroke(5)} {...stage} {...handlers} />)
    expect(grips()).toHaveLength(5)
    expect(plusses()).toHaveLength(4)
  })

  it('still reshapes a dense freehand stroke — thinned grips, both ends kept', () => {
    // 66 points was the field-exercise case: the old cap showed NOTHING here
    render(<WbVertexHandles anno={stroke(66)} {...stage} {...handlers} />)
    const g = grips()
    expect(g.length).toBeGreaterThan(1)
    expect(g.length).toBeLessThanOrEqual(MAX_VERTEX_HANDLES)
  })

  it('hides the «+» while the grips are thinned (its midpoint would not be on the path)', () => {
    render(<WbVertexHandles anno={stroke(66)} {...stage} {...handlers} />)
    expect(plusses()).toHaveLength(0)
  })

  it('keeps the Verlängern grips on a dense stroke — an end is always grabbable', () => {
    render(<WbVertexHandles anno={stroke(66)} {...stage} {...handlers} onExtend={noop} />)
    expect(screen.queryAllByRole('button', { name: M.extendLine })).toHaveLength(2)
  })

  // the hold-to-delete is the node grip's second gesture; the app-wide hold-tooltip must not
  // claim the same press and swallow its release (lib/holdTooltip · [data-holdaction])
  it('opts its grips out of the hold-tooltip, so the hold-to-delete keeps its release', () => {
    render(<WbVertexHandles anno={stroke(5)} {...stage} {...handlers} />)
    expect(grips().every((g) => g.hasAttribute('data-holdaction'))).toBe(true)
  })

  it('reports the REAL vertex index of a thinned grip, not its position in the shown set', () => {
    const onVertexDown = vi.fn()
    render(<WbVertexHandles anno={stroke(66)} {...stage} {...handlers} onVertexDown={onVertexDown} />)
    const g = grips()
    fireEvent.pointerDown(g[g.length - 1])
    expect(onVertexDown).toHaveBeenCalledWith(65, expect.anything())
  })
})
