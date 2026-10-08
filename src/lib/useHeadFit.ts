/*
 * What leaves the TOP BAR when it runs out of room is MEASURED, not ruled per breakpoint
 * (`lib/useHeadFit`, 25.09.2026): one `fit-N` step at a time until it fits, lowest priority
 * first — weather, Einsatzdauer, ↷, the gaps, the Verlauf word, the alarm's
 * name, the Einsatz title (the pill stays: glyph + ÜBUNG), the «1?» count, and last the
 * Eintrag's word (`'eintrag-word'`, 29.09.2026). The Einsatz pill never
 * gives: squeezed below a readable width counts as «does not fit». A chip NEVER loses its icon —
 * a bare number says nothing — and is at least a tap wide. A new chip in the bar takes its place
 * in that ladder, never a `:has(...)` rule that hides a neighbour. The PAGE HEADS climb the same
 * ladder (`climbLadder`, `lib/pageHeadFit`, 28.09.2026 — «ONE page head» in lib/pageHeadFit).
 */

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
 * its words at the same step), the «1?» count (the «?» stays), and last the word «Eintrag»
 * (29.09.2026, sweep K2 — it keeps it at 820 px; the glyph alone is the journal pen, never a «+»
 * that the rail's «+ Symbol» also wears). The pill is never the
 * thing that gives: a pill squeezed below a readable width counts as «does not fit»
 * (`headCrowded`).
 * ⚠️ A chip NEVER loses its icon (final walk-through, R1): at 360 px a bare red «5» said nothing
 * about five of what, while ↷ still held its 44 px. Every chip keeps its glyph and its number,
 * and is at least a tap wide (10-journal.css).
 * Each step is a class `fit-N` on the bar (10-journal.css); a higher step keeps the lower ones.
 */
export const HEAD_FIT_STEPS = [
  'weather-compact', 'weather', 'einsatzdauer', 'redo', 'gaps', 'verlauf-word',
  'vermisst-words', 'alarm-name', 'title', 'ask-count', 'eintrag-word',
] as const

/** The title's floor: roughly eight characters, or the whole title if it is shorter. */
const TITLE_FLOOR = 112

/**
 * PHONE: the street before ↷ and the weather (08.10.2026, coordinator's call after the one-letter
 * Übung marker). On the phone the pill's first line is the STREET (panels/IncidentSwitcher ·
 * twoLine) — where the Einsatz is, the one line the bar exists to show. Up to and including the
 * ↷ step, a street that ellipsises at all counts as «does not fit», so the weather, the
 * Einsatzdauer and ↷ only come back with what is LEFT once the street is whole (up to the pill's
 * own max). Past that step the 112px floor rules again: a very long street does not take the
 * Verlauf word, the alarm's name or ↶ with it. ↶ and Verlauf are not on this part of the ladder.
 */
export const STREET_BEFORE_STEP = HEAD_FIT_STEPS.indexOf('redo') + 1

/** Does the bar NOT fit — something painting past its edge, or the Einsatz pill squeezed?
 *  `step` is the ladder step being tried (Infinity = judge by the floors alone). */
export function headCrowded(bar: HTMLElement, step = Infinity): boolean {
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
  const cut = !!title && title.offsetParent !== null && title.scrollWidth > title.clientWidth + 1
  // the phone's street: whole before ↷ and the weather (STREET_BEFORE_STEP)
  if (cut && step < STREET_BEFORE_STEP && btn.classList.contains('ip-switch-two')) return true
  if (cut && title.clientWidth < Math.min(title.scrollWidth, TITLE_FLOOR)) return true
  return false
}

/**
 * THE ladder, shared by the top bar and the page heads (lib/pageHeadFit): from nothing collapsed,
 * one step at a time, until `crowded` says it fits or the steps run out. `apply(step)` puts the
 * element into that step (0 = nothing collapsed) and must be idempotent — every fit starts again
 * from 0, so a head that got WIDER gives its words back. Returns the step it stopped at.
 */
export function climbLadder(steps: number, apply: (step: number) => void, crowded: (step: number) => boolean): number {
  let step = 0
  apply(0)
  while (step < steps && crowded(step)) apply(++step)
  return step
}

/** Collapse step by step until the bar fits; returns the step it stopped at (0 = nothing). */
export function fitHead(bar: HTMLElement, crowded: (bar: HTMLElement, step: number) => boolean = headCrowded): number {
  return climbLadder(HEAD_FIT_STEPS.length, (step) => {
    for (let i = 1; i <= HEAD_FIT_STEPS.length; i++) bar.classList.toggle(`fit-${i}`, i <= step)
  }, (step) => crowded(bar, step))
}

/**
 * Keep the element fitted: whenever what it carries changes (`key`) and whenever the window resizes.
 * Classes are set on the DOM directly — measuring needs the layout of every step, and a React
 * state per step would render the bar ten times for one answer.
 * `fit` is the top bar's ladder by default; a page head passes `fitPageHead`. `observeSize` also
 * refits when the element's own WIDTH changes (a page head narrows when the rail expands or the
 * Checkliste's picker stands beside it — no window resize says so).
 */
export function useHeadFit(
  ref: RefObject<HTMLElement | null>, key: string,
  fit: (el: HTMLElement) => unknown = fitHead, observeSize = false,
) {
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current)
  }, [ref, key, fit])
  useEffect(() => {
    const on = () => { if (ref.current) fit(ref.current) }
    window.addEventListener('resize', on)
    // fonts arriving late change every width in the bar
    void document.fonts?.ready.then(on)
    // …and so does a chip coming or going inside the pill (a sync chip, the ÜBUNG marker): the
    // bar's own renders do not see those. Child lists only — the clock's text ticks every second.
    const mo = typeof MutationObserver === 'undefined' || !ref.current ? null : new MutationObserver(on)
    if (ref.current) mo?.observe(ref.current, { childList: true, subtree: true })
    // width only: the ladder's own last step (a second row) changes the HEIGHT, and refitting on
    // that would be a loop that settles on the same answer every time
    let width = -1
    const ro = !observeSize || typeof ResizeObserver === 'undefined' || !ref.current ? null
      : new ResizeObserver(([e]) => {
        const w = Math.round(e.contentRect.width)
        if (w !== width) { width = w; on() }
      })
    if (ref.current) ro?.observe(ref.current)
    return () => { window.removeEventListener('resize', on); mo?.disconnect(); ro?.disconnect() }
  }, [ref, fit, observeSize])
}
