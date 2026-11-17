import { describe, expect, it } from 'vitest'
import { placePiece, rowLift, stackLane, type Box } from './floatRow'

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

describe('stackLane — where the message lane starts while a tool is out (sweep 30.10.2026 #7)', () => {
  // an 844px phone: the dock 144..204 px above the foot, the pill 212..256 over it
  const dock = at(74, 316, 640, 700)
  const pill = at(101, 290, 588, 632)

  it('one gap above the pill when the chip sits beside the dock', () => {
    expect(stackLane([dock, pill, at(8, 52, 640, 692)], 844)).toBe(256 + 8)
  })

  it('one gap above the chip when it had to rise onto the pill\'s line', () => {
    expect(stackLane([dock, pill, at(8, 83, 580, 632)], 844)).toBe(264 + 8)
  })

  it('nothing in the stack: no lane of its own', () => {
    expect(stackLane([], 844)).toBeNull()
  })
})

// B+ (owner picks 13 + 14, 17.11.2026): a short bar shares its line with the row – at the bar's height
describe('placePiece — beside a bar at its height, or a line above', () => {
  const grow = { w: 8, h: 8 } // a 52px tile taking the bar's 60

  it('stands beside a short bar, at the bar\'s height', () => {
    const symbolDock = at(84, 306, 592, 652) // [Unfall · Mehrere · Abbrechen], centred
    expect(placePiece(chip, [symbolDock], symbolDock, grow)).toEqual({ lift: 0, beside: true })
  })

  it('asks at the grown size, so a tile that only fits small rises instead of flipping', () => {
    const dock = at(72, 318, 592, 652) // clears the 52px tile by 12, not the 60px one
    expect(rowLift(chip, [dock])).toBe(0)
    expect(placePiece(chip, [dock], dock, grow)).toEqual({ lift: 652 - 592 + 8, beside: false })
  })

  it('rises above a long bar, at its own height', () => {
    const lineDock = at(25, 365, 592, 652)
    expect(placePiece(chip, [lineDock], lineDock, grow)).toEqual({ lift: 652 - 592 + 8, beside: false })
  })

  it('without a bar on its line it only rises past what is in its way', () => {
    expect(placePiece(chip, [], null, grow)).toEqual({ lift: 0, beside: false })
  })
})
