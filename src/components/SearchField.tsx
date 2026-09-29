import { forwardRef, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'

/**
 * THE search field — «type to narrow this list» (29.09.2026, sweep C1). Glyph · input · ✕ ·
 * an optional count, in ONE look: the grey pill that turns white on focus (`.ui-search`,
 * 13-incident.css), --tap tall, the one corner, the one field focus on the BOX.
 *
 * It was built ten times — a framed white box on Anwesenheit/Mittel/Trupp form, a grey pill on
 * Palette/PlanPicker/Verlauf, a veil with a shadow and no ✕ on Alle Einsätze, a ruled band on
 * Hilfe and the Combo list, a bare native `type=search` on SharePosition/Datenquellen — and its
 * ✕ came in five sizes, the smallest a ~23px glyph on the two busiest tablet lists. Every search
 * is this component now; a surface places it (`className` on the pill), never re-skins it.
 *
 * The ✕ empties the field and keeps the caret in it (`onMouseDown` preventDefault — a blur would
 * close the phone keyboard on the way to an empty field the user is about to type into). It is a
 * full 44px square at the pill's right end, shown only while there is something to clear.
 *
 * `variant="head"`: the ONE documented modifier — a card whose whole head IS the search
 * (TruppFinder): no pill of its own (the card is the surface), the query 18/700 because it is
 * what the overlay is for.
 */
export const SearchField = forwardRef<HTMLInputElement, {
  value: string
  onChange: (v: string) => void
  /** what the ✕ says — «Suche leeren» by default */
  clearLabel?: string
  /** runs instead of `onChange('')` when the ✕ is pressed (a caller that also resets state) */
  onClear?: () => void
  /** a live read-out at the pill's end, e.g. «2 von 42» */
  count?: ReactNode
  /** the pill's class — for placement (flex, margin) and a surface's STATE, never its skin */
  className?: string
  variant?: 'head'
  /** the leading glyph — the lens unless a surface has a glyph of its own */
  icon?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'>>(
  function SearchField({ value, onChange, clearLabel, onClear, count, className, variant, icon = 'search', ...rest }, ref) {
    const label = clearLabel ?? appConfig.copy.clearSearch
    return (
      <label className={cx('ui-search', variant === 'head' && 'ui-search-head', className)}>
        <Icon id={icon} />
        <input
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          {...rest}
        />
        {count != null && <span className="ui-search-count" aria-live="polite">{count}</span>}
        {value !== '' && !rest.disabled && (
          <button
            type="button" className="ui-search-x" title={label} aria-label={label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (onClear ? onClear() : onChange(''))}
          ><Icon id="close" /></button>
        )}
      </label>
    )
  },
)
