import { describe, expect, it } from 'vitest'
import { laneOverSheet } from './toastLane'

/* 30.09.2026, owner («slightly odd positioning of the toasts»): a modal bottom sheet no longer
 * flips the phone's toasts to the top of the page — the lane stands one --float-gap above the
 * sheet, and goes to the top of the screen only when no pill fits above it. */
const geo = { layoutHeight: 664, ceiling: 10, pill: 52, gap: 8 }

describe('laneOverSheet', () => {
  it('keeps the bars lane without a sheet', () => {
    expect(laneOverSheet(null, geo)).toEqual({ mode: 'bars' })
  })
  it('stands one gap above the sheet\'s top edge', () => {
    // «Seite wählen»: its top at 388 → the pill's foot 8px above it = 284px over the layout foot
    expect(laneOverSheet(388, geo)).toEqual({ mode: 'sheet', bottom: 284 })
  })
  it('goes to the top of the screen when a pill no longer fits above the sheet', () => {
    expect(laneOverSheet(70, geo)).toEqual({ mode: 'sheet', bottom: 602 }) // 70 − 8 − 52 = 10: fits exactly
    expect(laneOverSheet(69, geo)).toEqual({ mode: 'top' })
    expect(laneOverSheet(24, geo)).toEqual({ mode: 'top' })
  })
})
