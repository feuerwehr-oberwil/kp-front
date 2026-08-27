import { describe, it, expect } from 'vitest'
import { COMPACT_SAVES, fitOverflow, nextCompact, type FitMeasure } from './composerFit'

/** one measurement; by default nothing caps the card and the screen is roomy */
const m = (needed: number, cap = Infinity, screen = 900): FitMeasure => ({ needed, cap, screen })
const FULL = 386 // the sheet's own height, measured (10-journal.css)
const COMPACT = FULL - COMPACT_SAVES

describe('composerFit · the ladder', () => {
  it('leaves the default layout alone while the sheet fits', () => {
    expect(nextCompact(false, m(FULL, 420))).toBe(false)
    expect(nextCompact(false, m(FULL, FULL))).toBe(false)
  })

  it('collapses the two lower rows the moment the card is over its cap', () => {
    expect(nextCompact(false, m(374, 368))).toBe(true)
  })

  // ⚠️ Why the screen is measured at all: the `pointer: fine` card was capped against the whole
  // screen while the keyboard ate the bottom of it, so nothing overflowed anything — the sheet
  // stood taller than the room and ran under the keyboard (see 10-journal.css).
  it('…and when the cap is too big to notice, but the screen is smaller than the sheet', () => {
    expect(nextCompact(false, m(FULL, 900, 360))).toBe(true)
    expect(nextCompact(false, m(FULL, 900, 620))).toBe(false)
    // no cap at all is the same question
    expect(nextCompact(false, m(FULL, Infinity, 360))).toBe(true)
  })

  it('stays compact rather than flipping back into a layout that overflows again', () => {
    expect(nextCompact(true, m(COMPACT, 340))).toBe(true)
    expect(nextCompact(true, m(COMPACT, COMPACT + COMPACT_SAVES))).toBe(false)
  })

  it('says how far off it is, whichever limit binds', () => {
    expect(fitOverflow(m(FULL, 340))).toBe(46) // over its cap
    expect(fitOverflow(m(FULL, 900, 360))).toBe(50) // over the screen, less its 24px reserve
  })

  // ⚠️ The rung must not depend on which rung asked. Both limits are read from things that do not
  // move with the layout, so feeding the compact height back through the measure has to settle.
  it('is a fixed point either way — one measure never chases the next', () => {
    const settle = (start: boolean, cap: number, screen = 900) => {
      let cur = start
      for (let i = 0; i < 6; i++) cur = nextCompact(cur, m(cur ? COMPACT : FULL, cap, screen))
      return cur
    }
    expect(settle(false, 500)).toBe(false) // roomy
    expect(settle(true, 500)).toBe(false) // …and it comes back out
    expect(settle(false, 360)).toBe(true) // tight cap: compact, and stay there
    expect(settle(true, 360)).toBe(true)
    expect(settle(false, 900, 360)).toBe(true) // uncapped card on a short screen
    expect(settle(false, 300)).toBe(true) // hopeless: compact, and the card scrolls
    // the knife edge: a cap that fits the compact sheet exactly must not flip
    expect(settle(false, COMPACT)).toBe(true)
    expect(settle(true, COMPACT)).toBe(true)
  })
})
