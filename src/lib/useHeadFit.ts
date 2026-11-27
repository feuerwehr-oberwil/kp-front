/*
 * What leaves the TOP BAR when it runs out of room is MEASURED, not ruled per breakpoint
 * (`lib/useHeadFit`, 25.09.2026): one `fit-N` step at a time until it fits, lowest priority
 * first — weather, Einsatzdauer, ↷, the gaps, the actions' words (ALL of them at once, to glyph
 * OVER word – `'action-words'`, pick 24a 17.11.2026), the alarm's name, the Einsatz title (the
 * pill stays: glyph + ÜBUNG), and last the «1?» count. The Einsatz pill never
 * gives: squeezed below a readable width counts as «does not fit». A chip NEVER loses its icon —
 * a bare number says nothing — and is at least a tap wide. A new chip in the bar takes its place
 * in that ladder, never a `:has(...)` rule that hides a neighbour. The PAGE HEADS climb the same
 * ladder (`climbLadder`, `lib/pageHeadFit`, 28.09.2026 — «ONE page head» in lib/pageHeadFit).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

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
 * gaps, the actions' words, the «vermisst» words, the alarm's name, the Einsatz title (the pill
 * stays, as its glyph and marker, a closed Einsatz's lock among them), and last the «1?» count
 * (the «?» stays). The pill is never the thing that gives: a pill squeezed below a readable width
 * counts as «does not fit» (`headCrowded`).
 * ⚠️ The actions' words fold TOGETHER and never leave (button sweep audit, owner pick 24a,
 * 17.11.2026): ↶ «Rückgängig», ↷, «Verlauf», «Eintrag» and «Standort» turn into tiles, glyph
 * OVER word, at ONE step (`'action-words'`, 10-journal · «the fold») – it used to be «Verlauf»
 * first and «Eintrag» last, one bare glyph at a time, beside an ↶ ↷ that never had a word. A phone
 * wears the tiles from the start (TopBar · `data-tiles`).
 * ⚠️ A chip NEVER loses its icon (final walk-through, R1): at 360 px a bare red «5» said nothing
 * about five of what, while ↷ still held its 44 px. Every chip keeps its glyph and its number,
 * and is at least a tap wide (10-journal.css).
 * Each step is a class `fit-N` on the bar (10-journal.css); a higher step keeps the lower ones.
 */
export const HEAD_FIT_STEPS = [
  'weather-compact', 'weather', 'einsatzdauer', 'redo', 'gaps', 'action-words',
  'vermisst-words', 'alarm-name', 'title', 'ask-count',
] as const

/** The title's floor: roughly eight characters, or the whole title if it is shorter. */
const TITLE_FLOOR = 112

/**
 * PHONE: the street before ↷ and the weather (08.10.2026, coordinator's call after the one-letter
 * Übung marker). On the phone the pill's first line is the street (lib/format · einsatzHeadName;
 * «Stichwort · street» 12.–18.11.2026 — panels/IncidentSwitcher · twoLine) — where the Einsatz is,
 * the one line the bar exists to show. Up to and including the ↷ step, a name that ellipsises at
 * all counts as «does not fit», so the weather, the
 * Einsatzdauer and ↷ only come back with what is LEFT once the street is whole (up to the pill's
 * own max). Past that step the 112px floor rules again: a very long street does not take the
 * actions' words, the alarm's name or ↶ with it. ↶ and Verlauf are not on this part of the ladder.
 */
export const STREET_BEFORE_STEP = HEAD_FIT_STEPS.indexOf('redo') + 1

/**
 * Run `measure` with every chip that is still arriving shown at its settled width, then put the
 * animations back where they were. The weather grows in from max-width 0 (10-journal · tb-chip-in),
 * and while it grows its content runs past its own box: measured mid-arrival, the ladder read that
 * as the bar's overflow, folded the weather, and every refit that showed it again replayed the
 * arrival – it never stood in a 1180 px bar with room to spare (Üben recorder, 26.11.2026).
 * Seeking to 1 ms before the end (not past it) leaves the animation unfinished: no end event, and
 * the arrival goes on from where it was.
 */
function asSettled<T>(bar: HTMLElement, measure: () => T): T {
  const arriving = (bar.getAnimations?.({ subtree: true }) ?? []).filter((a) =>
    a.playState === 'running' && 'animationName' in a && a.animationName === 'tb-chip-in')
  const at = arriving.map((a) => a.currentTime)
  for (const a of arriving) {
    const end = a.effect?.getComputedTiming().endTime
    if (typeof end === 'number') a.currentTime = end - 1
  }
  try { return measure() } finally { arriving.forEach((a, i) => { a.currentTime = at[i] }) }
}

/** Does the bar NOT fit — something painting past its edge, or the Einsatz pill squeezed?
 *  `step` is the ladder step being tried (Infinity = judge by the floors alone). */
export function headCrowded(bar: HTMLElement, step = Infinity): boolean {
  return asSettled(bar, () => crowdedNow(bar, step))
}

function crowdedNow(bar: HTMLElement, step: number): boolean {
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
  if (!title || title.offsetParent === null) return false
  // what the title would take whole (and what any part inside it lost to its own ellipsis)
  const wanted = title.scrollWidth + [...title.children].reduce(
    (lost, c) => lost + Math.max(0, c.scrollWidth - c.clientWidth), 0)
  const cut = wanted > title.clientWidth + 1
  // the phone's name: whole before ↷ and the weather (STREET_BEFORE_STEP)
  if (cut && step < STREET_BEFORE_STEP && btn.classList.contains('ip-switch-two')) return true
  if (cut && title.clientWidth < Math.min(wanted, TITLE_FLOOR)) return true
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

/** Have the page's fonts settled? Without `document.fonts` there is nothing to wait for. */
const fontsSettled = () => document.fonts?.status !== 'loading'

/**
 * Keep the element fitted: whenever what it carries changes (`key`) and whenever the window resizes.
 * Classes are set on the DOM directly — measuring needs the layout of every step, and a React
 * state per step would render the bar ten times for one answer.
 * `fit` is the top bar's ladder by default; a page head passes `fitPageHead`. `observeSize` also
 * refits when the element's own WIDTH changes (a page head narrows when the rail expands or the
 * Checkliste's picker stands beside it — no window resize says so).
 * ⚠️ Every fit restarts the ladder (style writes, layout reads), so the two late signals refit only
 * when they bring something new: the fonts' promise only when the last fit ran before they were in,
 * the size observer only when the width differs from the one the last fit measured. Its first
 * report on mount is the width the mount fit already had; a slow tablet paid a whole ladder for it.
 */
export function useHeadFit(
  ref: RefObject<HTMLElement | null>, key: string,
  fit: (el: HTMLElement) => unknown = fitHead, observeSize = false,
) {
  /** what the last fit measured: the border-box width (only where the size is observed) and
   *  whether the fonts were in */
  const last = useRef<{ width: number; fonts: boolean } | null>(null)
  const fitNow = useCallback((el: HTMLElement) => {
    fit(el)
    last.current = { width: observeSize ? el.offsetWidth : Number.NaN, fonts: fontsSettled() }
  }, [fit, observeSize])
  useLayoutEffect(() => {
    if (ref.current) fitNow(ref.current)
  }, [ref, key, fitNow])
  useEffect(() => {
    const on = () => { if (ref.current) fitNow(ref.current) }
    window.addEventListener('resize', on)
    // fonts arriving late change every width in the bar
    void document.fonts?.ready.then(() => { if (!last.current?.fonts) on() })
    // …and so does a chip coming or going inside the pill (a sync chip, the ÜBUNG marker): the
    // bar's own renders do not see those. Child lists only — the clock's text ticks every second.
    const mo = typeof MutationObserver === 'undefined' || !ref.current ? null : new MutationObserver(on)
    if (ref.current) mo?.observe(ref.current, { childList: true, subtree: true })
    // width only: the ladder's own last step (a second row) changes the HEIGHT, and refitting on
    // that would be a loop that settles on the same answer every time
    const ro = !observeSize || typeof ResizeObserver === 'undefined' || !ref.current ? null
      : new ResizeObserver(([e]) => {
        // the same box the fit measured; the observer reports after layout, so either read is free
        const w = Math.round(e.borderBoxSize?.[0]?.inlineSize ?? (e.target as HTMLElement).offsetWidth)
        if (w !== last.current?.width) on()
      })
    if (ref.current) ro?.observe(ref.current, { box: 'border-box' })
    return () => { window.removeEventListener('resize', on); mo?.disconnect(); ro?.disconnect() }
  }, [ref, fitNow, observeSize])
}
