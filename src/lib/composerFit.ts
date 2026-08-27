/** ── the journal composer's degradation ladder ────────────────────────────────────────────
 *  1. today's layout — and the predictive row is never what gives way, at any size;
 *  2. Art + media collapsed into ONE row of symbols («I · A · S», the clock, the ring, mic ·
 *     upload · camera) when the height gets tight;
 *  3. and only then the card scrolls (`overflow-y: auto`, 10-journal.css · .jc-controls).
 *
 *  ⚠️ MEASURED, not a `@media (max-height: …)`. On iOS the layout viewport does not shrink for
 *  the keyboard, so a height query reports the whole screen at exactly the moment half of it is
 *  gone — and on this surface the keyboard is up nearly always.
 */

/** What rung 2 is worth: one 44px row plus the 8px gap that went with it (10-journal.css). */
export const COMPACT_SAVES = 52

/**
 * Breathing room the sheet is not allowed to eat even where nothing caps it — roughly the 12px
 * the tablet card keeps above itself, top and bottom. It only matters in the fallback case
 * (`cap: Infinity`), where the screen is the only thing left to measure against.
 */
const SCREEN_RESERVE = 24

/** One measurement of the sheet. All px. */
export interface FitMeasure {
  /** the sheet's CONTENT height — `scrollHeight`, which is the whole of it whether or not the
   *  card is currently clipping it */
  needed: number
  /** the height the card is allowed: its used `max-height`, or `Infinity` where nothing caps it */
  cap: number
  /** the visible viewport: `visualViewport.height`, i.e. the screen minus the keyboard */
  screen: number
}

/**
 * By how much the sheet misses fitting — positive means it does not.
 *
 * ⚠️ TWO limits, and the second is not redundant. The cap is the one that normally binds, but a
 * cap can itself be too big: the `pointer: fine` card was capped against the whole screen while a
 * software keyboard ate the bottom of it (see 10-journal.css), so nothing overflowed anything —
 * the sheet simply stood taller than the room, ran under the keyboard, and iOS then scrolled its
 * top off the screen. The screen limit asks the question a wrong cap cannot dodge.
 *
 * ⚠️ Both are read from things that do NOT move when the ladder does — the used `max-height` and
 * the viewport, never the card's current height. That is what makes the rung stable: the answer
 * for «would the full layout fit» is the same whether it is being asked from rung 1 or rung 2,
 * so the sheet cannot flip between them frame after frame.
 */
export function fitOverflow(m: FitMeasure): number {
  return m.needed - Math.min(m.cap, m.screen - SCREEN_RESERVE)
}

/**
 * Whether the sheet should stand on rung 2, given what it just measured.
 *
 * ⚠️ Coming back OUT needs `COMPACT_SAVES` of slack, not a bare fit — the full layout is that
 * much taller, so anything less would drop the sheet into a layout that overflows again.
 */
export function nextCompact(compact: boolean, m: FitMeasure): boolean {
  const over = fitOverflow(m)
  // 1px of tolerance — sub-pixel row heights round `scrollHeight` up on their own
  return compact ? over + COMPACT_SAVES > 1 : over > 1
}
