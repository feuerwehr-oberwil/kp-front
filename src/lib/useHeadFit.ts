import { useEffect, useLayoutEffect, type RefObject } from 'react'

/**
 * The top bar's priority ladder (walk-through 25.09.2026, N12 / N23).
 *
 * The bar carries more than any phone — and on a busy Einsatz more than a tablet — has room for:
 * the Einsatz pill, ↶ ↷, the Verlauf, the Einsatzdauer, the weather, the Suche's «vermisst» chip
 * and the Atemschutz alarm. What goes first used to be decided by fixed rules per breakpoint
 * («an alarm hides the weather», «a chip hides the Einsatzdauer»), which were wrong in both
 * directions: the weather left a 1180 px bar that still had room for it, and at 360 px the flex
 * algorithm took every missing pixel out of the Einsatz pill — 20 px wide, the only door to the
 * Abschluss and the other Einsätze.
 *
 * So the bar is MEASURED: from nothing collapsed, one step at a time, until it fits. The order is
 * the priority, lowest first — the weather, the Einsatzdauer, ↷ (grey and rarely wanted), the
 * gaps, the Verlauf word, the «vermisst» words, the alarm's name, the Einsatz title (the pill
 * stays, as its glyph and marker — and the «Einsatz abgeschlossen» chip keeps its lock but gives
 * its words at the same step), and last the «1?» count (the «?» stays). The pill is never the
 * thing that gives: a pill squeezed below a readable width counts as «does not fit»
 * (`headCrowded`).
 * ⚠️ A chip NEVER loses its icon (final walk-through, R1): at 360 px a bare red «5» said nothing
 * about five of what, while ↷ still held its 44 px. Every chip keeps its glyph and its number,
 * and is at least a tap wide (10-journal.css).
 * Each step is a class `fit-N` on the bar (10-journal.css); a higher step keeps the lower ones.
 */
export const HEAD_FIT_STEPS = [
  'weather-compact', 'weather', 'einsatzdauer', 'redo', 'gaps', 'verlauf-word',
  'vermisst-words', 'alarm-name', 'title', 'ask-count',
] as const

/** The title's floor: roughly eight characters, or the whole title if it is shorter. */
const TITLE_FLOOR = 112

/** Does the bar NOT fit — something painting past its edge, or the Einsatz pill squeezed? */
export function headCrowded(bar: HTMLElement): boolean {
  if (bar.scrollWidth > bar.clientWidth + 1) return true
  const btn = bar.querySelector<HTMLElement>('.ip-switch-btn')
  if (!btn) return false
  // a glyph, a chevron or a sync chip painting out of the pill: the pill was squeezed
  if (btn.scrollWidth > btn.clientWidth + 1) return true
  // the ÜBUNG marker never truncates (a drill must never read as a real Einsatz)
  const badge = btn.querySelector<HTMLElement>(':scope > .ip-badge-exercise')
  if (badge && badge.offsetParent !== null && badge.scrollWidth > badge.clientWidth + 1) return true
  // the title may ellipsise, but not below a readable floor
  const title = btn.querySelector<HTMLElement>('.ip-switch-title')
  if (title && title.offsetParent !== null && title.scrollWidth > title.clientWidth + 1
    && title.clientWidth < Math.min(title.scrollWidth, TITLE_FLOOR)) return true
  return false
}

/** Collapse step by step until the bar fits; returns the step it stopped at (0 = nothing). */
export function fitHead(bar: HTMLElement, crowded: (bar: HTMLElement) => boolean = headCrowded): number {
  for (let i = 1; i <= HEAD_FIT_STEPS.length; i++) bar.classList.remove(`fit-${i}`)
  let step = 0
  while (step < HEAD_FIT_STEPS.length && crowded(bar)) {
    step++
    bar.classList.add(`fit-${step}`)
  }
  return step
}

/**
 * Keep the bar fitted: whenever what it carries changes (`key`) and whenever the window resizes.
 * Classes are set on the DOM directly — measuring needs the layout of every step, and a React
 * state per step would render the bar ten times for one answer.
 */
export function useHeadFit(ref: RefObject<HTMLElement | null>, key: string) {
  useLayoutEffect(() => {
    if (ref.current) fitHead(ref.current)
  }, [ref, key])
  useEffect(() => {
    const on = () => { if (ref.current) fitHead(ref.current) }
    window.addEventListener('resize', on)
    // fonts arriving late change every width in the bar
    void document.fonts?.ready.then(on)
    // …and so does a chip coming or going inside the pill (a sync chip, the ÜBUNG marker): the
    // bar's own renders do not see those. Child lists only — the clock's text ticks every second.
    const mo = typeof MutationObserver === 'undefined' || !ref.current ? null : new MutationObserver(on)
    if (ref.current) mo?.observe(ref.current, { childList: true, subtree: true })
    return () => { window.removeEventListener('resize', on); mo?.disconnect() }
  }, [ref])
}
