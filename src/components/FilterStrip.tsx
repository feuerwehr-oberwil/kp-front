import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate } from '../lib/format'
import { Button } from './Button'
import s from './FilterStrip.module.css'

/**
 * THE line that says a list is narrowed or re-sorted (owner pick, button sweep HEADS.3,
 * 17.11.2026): «Gefiltert: **Of · Wm** · 6 von 22 · [Alle zeigen]», ONE line under the list's head
 * row, with the way back beside it. It was the Verlauf's alone; every other surface said «on» by
 * the trigger's blue fill only and named the pick in a tooltip a touch device never shows, so a
 * narrowed Mannschaft read as the whole one.
 *
 * The trigger keeps its fixed width (29.09.2026: a label that comes and goes re-anchors the menu)
 * – what is picked is said HERE. Rendered only while something is picked; the caller decides.
 *
 * Used by the Anwesenheit (all three tabs), Mittel, «Alle Einsätze», the Trupps order (`sort`:
 * «Sortiert: Name · [Wie gesetzt]») and the Verlauf. The surface places it (`className`: its gutter),
 * never re-skins it.
 */
export function FilterStrip({ sort, what, count, clearLabel, onClear, className }: {
  /** a re-sorted list says «Sortiert:» – the default is «Gefiltert:» */
  sort?: boolean
  /** what is picked, the menu's own words joined with « · » */
  what: string
  /** «n von m» – only while nothing is typed: a search field counts both (the Verlauf's) */
  count?: { n: number; m: number }
  /** the way back – «Alle zeigen» unless a sort names its default («Wie gesetzt») */
  clearLabel?: string
  onClear: () => void
  className?: string
}) {
  const F = appConfig.copy.filterStrip
  return (
    <div className={cx(s.strip, className)}>
      <span className={s.text}>{sort ? F.sorted : F.filtered} <b>{what}</b></span>
      {count && (
        <span className={s.count} aria-live="polite">{fillTemplate(F.count, { n: count.n, m: count.m })}</span>
      )}
      <Button className={s.clear} onClick={onClear}>{clearLabel ?? F.showAll}</Button>
    </div>
  )
}
