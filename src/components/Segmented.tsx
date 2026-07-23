import type { ReactNode } from 'react'

/** The ONE segmented option-picker used across the details modal (ContextPanel): the Lüfter
 *  Luftrichtung, a symbol's on-canvas Beschriftung, and short fixed detail-field lists (e.g. a
 *  Kleinlöscher Typ) all render through this so they look + feel identical — a soft track with a
 *  blue-filled active segment, wrapping for longer sets. Longer lists / the Mannschaft roster keep
 *  the Combo dropdown instead. The caller owns toggle semantics: it decides which value to commit on
 *  click (e.g. a detail field clears when its active option is tapped again). */
export function Segmented<T extends string | number | boolean>({ options, value, onChange, ariaLabel }: {
  options: readonly { value: T; label: ReactNode; disabled?: boolean; title?: string }[]
  value: T | undefined
  onChange: (value: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="useg" role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = value === o.value
        return (
          <button key={String(o.value)} type="button" className={`useg-btn${on ? ' on' : ''}`} title={o.title}
            aria-pressed={on} disabled={o.disabled} onClick={() => onChange(o.value)}>{o.label}</button>
        )
      })}
    </div>
  )
}
