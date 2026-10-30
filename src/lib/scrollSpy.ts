// Scroll-spy for one long scrolled document with a table of contents beside it (the Hilfe,
// HelpOverlay). Pure: the caller measures, this decides which section is «where you are».
//
// Why not an IntersectionObserver band (what the Hilfe had until 30.10.2026): it only reports
// sections CROSSING the band, so scrolling up never re-activated the section above, and the last
// short sections never reached the band at all – the TOC stuck on an earlier entry at the end.

/** What the picker needs from the scroller, all in px. `tops` are each section's top edge
 *  relative to the scroller's visible top edge (negative = scrolled past), in document order. */
export interface SpyGeometry {
  tops: readonly number[]
  scrollTop: number
  viewHeight: number
  scrollHeight: number
}

/** The band line sits this far down the visible pane: a section «is» the current one once its
 *  top has passed above it. */
export const SPY_LINE = 0.3

/**
 * The index of the active section: the last one whose top is at or above the band line; at the
 * scroll bottom, the last section (a short tail section can never reach the line). Before any
 * section has reached the line, the first. -1 only when there are no sections.
 */
export function pickActiveSection({ tops, scrollTop, viewHeight, scrollHeight }: SpyGeometry): number {
  if (tops.length === 0) return -1
  // `scrollTop > 0`: a pane that does not scroll at all is at its top AND its bottom – that is
  // the top. 1px of slack for fractional scroll positions (zoom, dsf 3).
  if (scrollTop > 0 && scrollTop + viewHeight >= scrollHeight - 1) return tops.length - 1
  const line = viewHeight * SPY_LINE
  let active = 0
  tops.forEach((top, i) => { if (top <= line) active = i })
  return active
}
