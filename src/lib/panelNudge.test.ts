import { describe, expect, it } from 'vitest'
import { panelNudge, panelNudgeBox, panelNudgeBoxUp } from './panelNudge'

// panel occupying the right band of a 1280×800 surface (desktop .ctx geometry)
const panel = { left: 804, top: 88, bottom: 760 }

describe('panelNudge', () => {
  it('leaves selections in the open area alone', () => {
    expect(panelNudge({ x: 400, y: 300 }, panel)).toBeNull()
    expect(panelNudge({ x: 748, y: 300 }, panel)).toBeNull() // exactly at the margin edge
  })

  it('nudges an occluded selection just clear of the panel edge', () => {
    expect(panelNudge({ x: 900, y: 300 }, panel)).toEqual([152, 0]) // 900 - (804 - 56)
    expect(panelNudge({ x: 760, y: 300 }, panel)).toEqual([12, 0])  // barely inside the margin
  })

  it('ignores points above or below the panel', () => {
    expect(panelNudge({ x: 900, y: 10 }, panel)).toBeNull()
    expect(panelNudge({ x: 900, y: 830 }, panel)).toBeNull()
  })

  it('respects a custom margin', () => {
    expect(panelNudge({ x: 800, y: 300 }, panel, 0)).toBeNull()
    expect(panelNudge({ x: 810, y: 300 }, panel, 0)).toEqual([6, 0])
  })
})

describe('panelNudgeBox (drawings — line/area/circle extents)', () => {
  it('leaves an extent in the open area alone', () => {
    expect(panelNudgeBox({ minX: 200, maxX: 700, minY: 200, maxY: 400 }, panel)).toBeNull()
  })

  it('brings a partially occluded extent clear of the panel edge', () => {
    // right edge at 900 → shift left by 900 - (804 - 56) = 152, like a point there
    expect(panelNudgeBox({ minX: 500, maxX: 900, minY: 200, maxY: 400 }, panel)).toEqual([152, 0])
  })

  it('caps the shift so a wide extent keeps its left edge on the surface', () => {
    // clearing the panel would need 152px, but the left edge sits at 100 → only 44 remain
    expect(panelNudgeBox({ minX: 100, maxX: 900, minY: 200, maxY: 400 }, panel)).toEqual([44, 0])
    // left edge already at the margin → nothing to gain, stay calm
    expect(panelNudgeBox({ minX: 40, maxX: 900, minY: 200, maxY: 400 }, panel)).toBeNull()
  })

  it('ignores extents entirely above or below the panel band', () => {
    expect(panelNudgeBox({ minX: 500, maxX: 900, minY: 0, maxY: 20 }, panel)).toBeNull()
    expect(panelNudgeBox({ minX: 500, maxX: 900, minY: 830, maxY: 900 }, panel)).toBeNull()
  })

  it('degenerates to the point behaviour for a single-point box', () => {
    expect(panelNudgeBox({ minX: 900, maxX: 900, minY: 300, maxY: 300 }, panel)).toEqual([152, 0])
    expect(panelNudgeBox({ minX: 748, maxX: 748, minY: 300, maxY: 300 }, panel)).toBeNull()
  })
})

describe('panelNudgeBoxUp (bottom sheet)', () => {
  const sheet = { top: 420 }

  it('leaves an extent above the sheet alone', () => {
    expect(panelNudgeBoxUp({ minX: 100, maxX: 300, minY: 100, maxY: 364 }, sheet)).toBeNull()
  })

  it('shifts an occluded extent up clear of the sheet', () => {
    expect(panelNudgeBoxUp({ minX: 100, maxX: 300, minY: 300, maxY: 500 }, sheet)).toEqual([0, 136])
  })

  it('caps the shift so a tall extent keeps its top edge on the surface', () => {
    // clearing would need 236px, but the top edge sits at 150 → only 94 remain
    expect(panelNudgeBoxUp({ minX: 100, maxX: 300, minY: 150, maxY: 600 }, sheet)).toEqual([0, 94])
    expect(panelNudgeBoxUp({ minX: 100, maxX: 300, minY: 40, maxY: 600 }, sheet)).toBeNull()
  })
})
