import { describe, expect, it } from 'vitest'
import { rowLift, type Box } from './floatRow'

// A 390px phone: the chip row at its floor, 8px in from the left, 52px tall.
const chip: Box = { left: 8, right: 60, top: 600, bottom: 652 }
const at = (left: number, right: number, top: number, bottom: number): Box => ({ left, right, top, bottom })

describe('rowLift — the floating chip row on the lowest free line (sweep 27.10.2026 #9)', () => {
  it('stays on its floor beside a short centred dock', () => {
    // Mehrfach's [ⓘ | ✕] dock: 120px wide, centred, on the same line
    expect(rowLift(chip, [at(135, 255, 592, 652)])).toBe(0)
  })

  it('rises one gap above a dock that reaches under it', () => {
    // the line tool's dock spans nearly the whole width
    expect(rowLift(chip, [at(30, 360, 592, 652)])).toBe(652 - 592 + 8)
  })

  it('rises past a pill stacked on the dock it rose above', () => {
    const dock = at(30, 360, 592, 652)
    const pill = at(40, 300, 530, 574)
    expect(rowLift(chip, [pill, dock])).toBe(652 - 530 + 8)
  })

  it('ignores what stands clear of it sideways or above', () => {
    expect(rowLift(chip, [at(70, 200, 600, 652), at(0, 390, 300, 400)])).toBe(0)
  })
})
