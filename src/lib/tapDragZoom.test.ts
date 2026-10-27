import { describe, expect, it } from 'vitest'
import { createTapDragZoom, oneFingerZoom, PX_PER_DOUBLING, TAP_GAP_MS, TAP_MAX_DIST_PX, TAP_MAX_MS, TAP_DRAG_ENGAGE_PX, type TapSample } from './tapDragZoom'

const p = (id: number, x: number, y: number, t: number, pointerType = 'touch'): TapSample => ({ id, x, y, t, pointerType })

/** one quick, still tap with pointer `id` at (x, y), pressed at t and lifted 80 ms later */
const tap = (g: ReturnType<typeof createTapDragZoom>, id: number, x: number, y: number, t: number) => {
  g.down(p(id, x, y, t))
  return g.up(p(id, x, y, t + 80))
}

describe('tapDragZoom · double tap', () => {
  it('a second quick tap near the first is one zoom step, about the FIRST tap', () => {
    const g = createTapDragZoom()
    expect(tap(g, 1, 100, 200, 0)).toBeNull()
    expect(g.down(p(2, 110, 205, 200))).toEqual({ kind: 'arm', at: { x: 100, y: 200 } })
    expect(g.owns(2)).toBe(true)
    expect(g.up(p(2, 111, 205, 260))).toEqual({ kind: 'zoomStep', at: { x: 100, y: 200 } })
    expect(g.owns(2)).toBe(false)
  })

  it('a single tap does nothing', () => {
    const g = createTapDragZoom()
    expect(tap(g, 1, 100, 200, 0)).toBeNull()
    expect(g.owns(1)).toBe(false)
  })

  it('the second press comes too late → it is a fresh first press', () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    expect(g.down(p(2, 100, 200, 80 + TAP_GAP_MS + 1))).toBeNull()
    expect(g.owns(2)).toBe(false)
  })

  it('the second press lands too far away → not a double tap', () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    expect(g.down(p(2, 100 + TAP_MAX_DIST_PX + 1, 200, 200))).toBeNull()
  })

  it('a first press held too long is not a tap', () => {
    const g = createTapDragZoom()
    g.down(p(1, 100, 200, 0))
    g.up(p(1, 100, 200, TAP_MAX_MS + 1))
    expect(g.down(p(2, 100, 200, TAP_MAX_MS + 50))).toBeNull()
  })

  it('a first press that MOVED (a pan) is not a tap', () => {
    const g = createTapDragZoom()
    g.down(p(1, 100, 200, 0))
    g.move(p(1, 100, 200 + TAP_MAX_DIST_PX + 1, 40))
    g.move(p(1, 100, 200, 60)) // even if it comes back
    g.up(p(1, 100, 200, 80))
    expect(g.down(p(2, 100, 200, 150))).toBeNull()
  })

  it('a second press held long and lifted still ends without a step', () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    g.down(p(2, 100, 200, 200))
    expect(g.up(p(2, 100, 200, 200 + TAP_MAX_MS + 1))).toEqual({ kind: 'end' })
  })

  it('a press elsewhere (a chip) between the taps breaks the pair', () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    // the board never sees a chip's down, only its up through the capture pass
    expect(g.up(p(7, 300, 300, 150))).toBeNull()
    expect(g.down(p(2, 100, 200, 200))).toBeNull()
  })

  it('ignores the mouse altogether', () => {
    const g = createTapDragZoom()
    g.down(p(1, 100, 200, 0, 'mouse'))
    g.up(p(1, 100, 200, 80, 'mouse'))
    expect(g.down(p(1, 100, 200, 200, 'mouse'))).toBeNull()
    // …and a mouse press between two touches breaks the pair
    tap(g, 2, 100, 200, 300)
    g.down(p(1, 100, 200, 400, 'mouse'))
    expect(g.down(p(3, 100, 200, 450))).toBeNull()
  })

  it('takes a pen like a finger', () => {
    const g = createTapDragZoom()
    g.down(p(1, 100, 200, 0, 'pen'))
    g.up(p(1, 100, 200, 80, 'pen'))
    expect(g.down(p(1, 100, 200, 200, 'pen'))?.kind).toBe('arm')
  })
})

describe('tapDragZoom · tap, then press and drag', () => {
  const armed = () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    g.down(p(2, 100, 200, 200))
    return g
  }

  it('holds still under the engage threshold (and owns the pointer meanwhile)', () => {
    const g = armed()
    expect(g.move(p(2, 100, 200 + TAP_DRAG_ENGAGE_PX, 220))).toEqual({ kind: 'hold' })
    expect(g.owns(2)).toBe(true)
  })

  it('engages at ×1 — no jump — then down zooms in, up zooms out, ×2 per 128 px', () => {
    const g = armed()
    const y0 = 200 + TAP_DRAG_ENGAGE_PX + 1
    expect(g.move(p(2, 100, y0, 220))).toEqual({ kind: 'zoom', factor: 1, at: { x: 100, y: 200 } })
    const down = g.move(p(2, 100, y0 + PX_PER_DOUBLING, 260))
    expect(down).toEqual({ kind: 'zoom', factor: 2, at: { x: 100, y: 200 } })
    const up = g.move(p(2, 100, y0 - PX_PER_DOUBLING, 300))
    expect(up?.kind === 'zoom' && up.factor).toBeCloseTo(0.5, 9)
  })

  it('the factor is relative to where the drag engaged, so it never drifts', () => {
    const g = armed()
    g.move(p(2, 100, 220, 220))
    for (let i = 0; i < 50; i++) g.move(p(2, 100, 220 + (i % 7) * 13, 230 + i))
    const back = g.move(p(2, 100, 220, 400))
    expect(back?.kind === 'zoom' && back.factor).toBe(1)
  })

  it('a sideways drag zooms only by its vertical part', () => {
    const g = armed()
    g.move(p(2, 120, 200, 220)) // engages sideways at y=200
    expect(g.move(p(2, 300, 200, 260))).toEqual({ kind: 'zoom', factor: 1, at: { x: 100, y: 200 } })
  })

  it('releasing after a drag ends it — no step on top', () => {
    const g = armed()
    g.move(p(2, 100, 240, 220))
    expect(g.up(p(2, 100, 240, 300))).toEqual({ kind: 'end' })
    expect(g.owns(2)).toBe(false)
    // …and the next press is a fresh start, not a third tap
    expect(g.down(p(3, 100, 200, 350))).toBeNull()
  })

  it('a second finger cancels it (the pinch takes over)', () => {
    const g = armed()
    g.move(p(2, 100, 240, 220))
    expect(g.down(p(3, 200, 300, 230))).toEqual({ kind: 'end' })
    expect(g.owns(2)).toBe(false)
    expect(g.move(p(2, 100, 400, 240))).toBeNull()
    expect(g.up(p(2, 100, 400, 260))).toBeNull()
  })

  it('a second finger during the FIRST press cancels too', () => {
    const g = createTapDragZoom()
    g.down(p(1, 100, 200, 0))
    expect(g.down(p(2, 200, 200, 20))).toBeNull()
    g.up(p(2, 200, 200, 60))
    g.up(p(1, 100, 200, 80))
    expect(g.down(p(3, 100, 200, 150))).toBeNull()
  })

  it('cancel() reports end only when it owned a pointer', () => {
    const g = armed()
    expect(g.cancel()).toEqual({ kind: 'end' })
    expect(g.cancel()).toBeNull()
  })

  it('moves of other pointers are none of its business', () => {
    const g = armed()
    expect(g.move(p(9, 100, 400, 220))).toBeNull()
    expect(g.owns(2)).toBe(true)
  })
})

// UX sweep M4 (21.10.2026): under a drag tool (Freihand) the double tap zooms, the drag stays
// the tool's
describe('tapDragZoom · double tap only (drag: false)', () => {
  it('a double tap is still one zoom step', () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    g.down(p(2, 100, 200, 200), { drag: false })
    expect(g.up(p(2, 100, 200, 260))).toEqual({ kind: 'zoomStep', at: { x: 100, y: 200 } })
  })

  it('a second press that travels is handed back: no zoom, and its release is no tap', () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    g.down(p(2, 100, 200, 200), { drag: false })
    expect(g.move(p(2, 100, 200 + TAP_DRAG_ENGAGE_PX + 1, 220))).toEqual({ kind: 'end' })
    expect(g.owns(2)).toBe(false)
    expect(g.up(p(2, 100, 260, 300))).toBeNull()
  })

  it('…also when its moves went to the tool unseen: a quick release far off is no tap', () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    g.down(p(2, 100, 200, 200), { drag: false })
    expect(g.up(p(2, 180, 200, 300))).toEqual({ kind: 'end' })
  })
})

// Sweep 27.10.2026 #8: under a TAP tool (Messen, Punkte, Symbol …) tap-and-drag zooms, but a quick
// second press stays the tool's own tap — a double tap there is two placements, never a zoom step
describe('tapDragZoom · drag only (step: false)', () => {
  it('the second press, dragged, zooms', () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    expect(g.down(p(2, 100, 200, 200), { step: false })).toEqual({ kind: 'arm', at: { x: 100, y: 200 } })
    expect(g.move(p(2, 100, 200 + TAP_DRAG_ENGAGE_PX + 1, 220))).toEqual({ kind: 'zoom', factor: 1, at: { x: 100, y: 200 } })
    expect(g.move(p(2, 100, 200 + TAP_DRAG_ENGAGE_PX + 1 + PX_PER_DOUBLING, 260))).toMatchObject({ kind: 'zoom', factor: 2 })
  })

  it('a quick second press is no zoom step — it ends, and the tool gets its tap', () => {
    const g = createTapDragZoom()
    tap(g, 1, 100, 200, 0)
    g.down(p(2, 100, 200, 200), { step: false })
    expect(g.up(p(2, 100, 200, 260))).toEqual({ kind: 'end' })
  })
})

describe('oneFingerZoom · one rule for Lage, Plan and Karte', () => {
  it.each([
    ['Auswahl / Mehrfach / no tool', { taps: false, drags: false }, { step: true, drag: true }],
    ['Messen, Punkte, Symbol – places on a tap', { taps: true, drags: false }, { step: false, drag: true }],
    ['Freihand – draws with the drag', { taps: false, drags: true }, { step: true, drag: false }],
    ['Absperrkreis – tap and drag are both the tool’s', { taps: true, drags: true }, { step: false, drag: false }],
  ])('%s', (_, tool, want) => {
    expect(oneFingerZoom(tool)).toEqual(want)
  })
})
