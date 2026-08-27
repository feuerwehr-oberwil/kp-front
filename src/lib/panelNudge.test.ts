import { describe, expect, it } from 'vitest'
import { nudgePointIntoRect, nudgeSelectionIntoRect, rectCenter, visibleWorkRect } from './panelNudge'

describe('padded visible workspace', () => {
  const surface = { minX: 0, maxX: 1200, minY: 0, maxY: 800 }
  const sidePanel = { minX: 820, maxX: 1200, minY: 80, maxY: 780 }

  it('reserves padding around every border and the side panel', () => {
    const visible = visibleWorkRect(surface, sidePanel, false)
    expect(visible).toEqual({ minX: 56, maxX: 764, minY: 56, maxY: 744 })
    expect(rectCenter(visible)).toEqual({ x: 410, y: 400 })
  })

  it('uses the same padded rule above a phone bottom sheet', () => {
    const sheet = { minX: 0, maxX: 400, minY: 460, maxY: 800 }
    expect(visibleWorkRect({ ...surface, maxX: 400 }, sheet, true)).toEqual({
      minX: 56, maxX: 344, minY: 56, maxY: 404,
    })
  })

  it('nudges a point away from viewport borders as well as panels', () => {
    const visible = visibleWorkRect(surface, sidePanel, false)
    expect(nudgePointIntoRect({ x: 12, y: 790 }, visible)).toEqual([-44, 46])
    expect(nudgePointIntoRect({ x: 400, y: 300 }, visible)).toBeNull()
  })

  it('keeps a small extent fully visible with snug padding', () => {
    const visible = visibleWorkRect(surface, sidePanel, false)
    expect(nudgeSelectionIntoRect(
      { minX: 720, maxX: 800, minY: 100, maxY: 180 }, null, visible,
    )).toEqual([36, 0])
  })

  it('does not zoom or chase a long line; it keeps the tapped part visible', () => {
    const visible = visibleWorkRect(surface, sidePanel, false)
    const long = { minX: -500, maxX: 1800, minY: 200, maxY: 230 }
    expect(nudgeSelectionIntoRect(long, { x: 900, y: 215 }, visible)).toEqual([136, 0])
    expect(nudgeSelectionIntoRect(long, { x: 300, y: 215 }, visible)).toBeNull()
  })

  it('brings the nearest edge in when an oversized extent is wholly off-screen', () => {
    const visible = visibleWorkRect(surface, sidePanel, false)
    expect(nudgeSelectionIntoRect(
      { minX: 900, maxX: 2200, minY: 200, maxY: 230 }, null, visible,
    )).toEqual([136, 0])
  })
})
