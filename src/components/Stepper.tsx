import { useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { useHoldRepeat } from '../lib/useHoldRepeat'

/**
 * The canonical compact ±stepper (global `.step` chrome). Three behaviours, consistent everywhere:
 *  - press-and-HOLD the ±buttons to repeat fast (reach e.g. 40 without 40 taps)
 *  - TAP the value to type an exact number in directly
 *  - the reset ✕ is ALWAYS rendered (no layout shift); it just greys out when there's nothing
 *    to reset (`canClear` false), instead of appearing/disappearing.
 *
 * `value` may be null for OPTIONAL fields (no badge yet): the display shows `placeholder`, − is
 * disabled, and + seeds `seed ?? min`. `onChange` always receives a concrete clamped number.
 */
export function Stepper({ value, min, max, step = 1, seed, format, placeholder = '–', onChange, onClear, canClear, readOnly, over, ariaLabel }: {
  value: number | null
  min: number
  max: number
  step?: number
  /** value to seed when stepping up from an empty (null) optional field; defaults to `min` */
  seed?: number
  /** format the numeric value for display (e.g. signed floor "+2", "47 m") */
  format?: (v: number) => string
  placeholder?: string
  onChange: (v: number) => void
  /** reset to the default/empty state. Omit to hide the ✕ entirely. */
  onClear?: () => void
  /** whether a reset would do anything; false ⇒ the ✕ stays visible but greyed/disabled */
  canClear?: boolean
  readOnly?: boolean
  /** flag the value in red — e.g. Mittel usage past the available stock (allowed, but surfaced) */
  over?: boolean
  ariaLabel?: string
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  const has = value != null
  const dec = useHoldRepeat(() => { if (has) onChange(clamp(value - step)) })
  const inc = useHoldRepeat(() => onChange(has ? clamp(value + step) : (seed ?? min)))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const startEdit = () => { if (readOnly) return; setDraft(has ? String(value) : ''); setEditing(true) }
  const commit = () => {
    setEditing(false)
    const n = parseInt(draft, 10)
    if (!Number.isNaN(n)) onChange(clamp(n))
  }
  const display = has ? (format ? format(value) : String(value)) : placeholder
  const st = appConfig.copy.stepper

  return (
    <span className="step" role="group" aria-label={ariaLabel}>
      <button className="step-btn" disabled={readOnly || !has || value <= min} {...dec} aria-label={st.less}>−</button>
      {editing ? (
        <input
          className="step-val step-input" autoFocus value={draft} inputMode="numeric" type="text"
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setEditing(false) }}
        />
      ) : (
        <button className={`step-val step-val-btn${over ? ' step-over' : ''}`} onClick={startEdit} disabled={readOnly} title={st.typeToEnter}>{display}</button>
      )}
      <button className="step-btn" disabled={readOnly || (has && value >= max)} {...inc} aria-label={st.more}>+</button>
      {onClear && (
        <button className="step-clear" disabled={readOnly || !canClear} onClick={onClear} aria-label={st.reset}><Icon id="close" /></button>
      )}
    </span>
  )
}
