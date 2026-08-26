import { describe, it, expect } from 'vitest'
import { COMPACT_SAVES, nextCompact } from './composerFit'

describe('composerFit · the ladder', () => {
  it('leaves the default layout alone while the sheet fits', () => {
    expect(nextCompact(false, 368, 420)).toBe(false)
    expect(nextCompact(false, 368, 368)).toBe(false)
  })

  it('collapses the two lower rows the moment it does not', () => {
    expect(nextCompact(false, 374, 368)).toBe(true)
  })

  it('stays compact rather than flipping back into a layout that overflows again', () => {
    // 316px of compact sheet in 340px of card: the full one would be 368 and overflow
    expect(nextCompact(true, 316, 340)).toBe(true)
    // …and only lets go once the row it dropped would fit again
    expect(nextCompact(true, 316, 316 + COMPACT_SAVES)).toBe(false)
  })

  it('is a fixed point either way — one measure never chases the next', () => {
    const settle = (start: boolean, scrollH: number, clientH: number) => {
      // compact costs the sheet COMPACT_SAVES of height, so feed the measure back through it
      let cur = start
      for (let i = 0; i < 4; i++) cur = nextCompact(cur, cur ? scrollH - COMPACT_SAVES : scrollH, clientH)
      return cur
    }
    expect(settle(false, 368, 500)).toBe(false) // roomy
    expect(settle(false, 368, 330)).toBe(true) // tight: compact and stay there
    expect(settle(true, 368, 500)).toBe(false) // …and back out when the keyboard closes
    expect(settle(false, 368, 300)).toBe(true) // hopeless: compact, and the card scrolls
  })
})
