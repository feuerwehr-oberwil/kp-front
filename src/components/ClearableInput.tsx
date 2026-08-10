import { forwardRef } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'

/**
 * A one-line text field with a ✕ that empties it.
 *
 * For the handful of fields that are REWRITTEN rather than filled in once — the Trupp's Ziel
 * (a Trupp gets a new order and the old one is not a starting point for the new one), the
 * Rapport's after-the-fact lines, the free «Anderes Mittel» name. Clearing those meant
 * long-pressing to select all and hitting backspace, on a phone, with a glove on; the search
 * boxes have had a ✕ for exactly this reason and these fields behave the same way.
 *
 * ⚠️ NOT for fields whose content is a record. The ✕ is a one-tap wipe with no undo behind it,
 * so it belongs on values that are being composed, never on ones that have been committed
 * (times, pressures, names on the Anwesenheit). If in doubt it does not get one.
 *
 * The ✕ appears only when there is something to clear, keeps the input focused through the tap
 * (`onMouseDown` preventDefault — otherwise the field blurs and the phone keyboard closes on
 * the way to an empty field the user is about to type into), and is a full 44px target that
 * overlaps the field's right padding rather than shrinking it.
 */
export const ClearableInput = forwardRef<HTMLInputElement, {
  value: string
  onChange: (v: string) => void
  /** what the ✕ says it clears — «Ziel leeren». Falls back to the generic «Leeren». */
  clearLabel?: string
  className?: string
  /** wrapper class, for callers that size the field from the outside (grid cells) */
  wrapClassName?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'>>(
  function ClearableInput({ value, onChange, clearLabel, className, wrapClassName, ...rest }, ref) {
    const label = clearLabel ?? appConfig.copy.clear
    return (
      <span className={cx('ci', wrapClassName)}>
        <input
          ref={ref}
          className={cx('ci-input', className)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        />
        {value !== '' && !rest.disabled && !rest.readOnly && (
          <button
            type="button" className="ci-clear" title={label} aria-label={label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange('')}
          ><Icon id="close" /></button>
        )}
      </span>
    )
  },
)
