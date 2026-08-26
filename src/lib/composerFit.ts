/** ── the journal composer's degradation ladder ────────────────────────────────────────────
 *  1. today's layout — and the predictive row is never what gives way, at any size;
 *  2. Art + media collapsed into ONE row of symbols («I · A · S», the clock, the ring, mic ·
 *     upload · camera) when the height gets tight;
 *  3. and only then the card scrolls (`overflow-y: auto`, 10-journal.css · .jc-controls).
 *
 *  ⚠️ MEASURED, not a `@media (max-height: …)`. On iOS the layout viewport does not shrink for
 *  the keyboard, so a height query reports the whole screen at exactly the moment half of it is
 *  gone — and on this surface the keyboard is up nearly always. The card is its own scrollport,
 *  so `scrollHeight > clientHeight` IS «does not fit», whatever ate the room: the keyboard, a
 *  short window, a photo strip, an imported memo.
 */

/** What rung 2 is worth: one 44px row plus the 8px gap that went with it (10-journal.css). */
export const COMPACT_SAVES = 52

/**
 * Whether the sheet should stand on rung 2, given what the card just measured.
 *
 * ⚠️ Coming back OUT needs that much slack, not a bare fit: without the hysteresis the sheet
 * would leave the compact row into a layout that immediately overflows again, and flip on
 * every frame.
 */
export function nextCompact(compact: boolean, scrollH: number, clientH: number): boolean {
  // 1px of tolerance — sub-pixel row heights round `scrollHeight` up on their own
  if (!compact) return scrollH > clientH + 1
  return scrollH + COMPACT_SAVES > clientH
}
