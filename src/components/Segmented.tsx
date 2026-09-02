import type { ReactNode } from 'react'
import { appConfig } from '../config/appConfig'

/** The ONE segmented option-picker used across the details modal (ContextPanel): the Lüfter
 *  Luftrichtung, a symbol's on-canvas Beschriftung, and short fixed detail-field lists (e.g. a
 *  Kleinlöscher Typ) all render through this so they look + feel identical — a soft track with a
 *  blue-filled active segment, wrapping for longer sets. Longer lists / the Mannschaft roster keep
 *  the Combo dropdown instead. The caller owns toggle semantics: it decides which value to commit on
 *  click (e.g. a detail field clears when its active option is tapped again). */
export function Segmented<T extends string | number | boolean>({ options, value, onChange, ariaLabel, explain }: {
  options: readonly { value: T; label: ReactNode; disabled?: boolean; title?: string }[]
  value: T | undefined
  onChange: (value: T) => void
  ariaLabel?: string
  /**
   * The options carry an EXPLANATION rather than a name, delivered through the app's own bubble —
   * hold on touch, hover on mouse (lib/holdTooltip · `data-holdexplain`). Use it where the segment
   * is a picture or a code that means nothing to somebody who has not used the sheet for six
   * months; the Typ letters in the Linien-Editor are the pattern.
   *
   * ⚠️ It also DROPS the native `title`, deliberately: leaving both makes the browser's own
   * tooltip arrive a second later and say the same sentence twice.
   */
  explain?: boolean
}) {
  return (
    <div className="useg" role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = value === o.value
        return (
          <button key={String(o.value)} type="button" className={`useg-btn${on ? ' on' : ''}`}
            {...(explain ? { 'data-holdexplain': true, 'aria-label': o.title } : { title: o.title })}
            aria-pressed={on} disabled={o.disabled} onClick={() => onChange(o.value)}>{o.label}</button>
        )
      })}
    </div>
  )
}

/**
 * A yes/no property, in the app's ONE binary idiom (decided 01.09.): the Segmented pair, «Aus»
 * left and «An» right. Both answers stay on screen, so «ist das an» is read rather than deduced
 * from a single chip — which, before this, showed the state it was IN on some rows and carried
 * only an icon on others, three idioms for one question inside the same two sheets.
 * ⚠️ The labels are read HERE, inside the component: captured at module level they would freeze
 * the catalogue at import time and never follow the deployment's locale (AGENTS.md · i18n).
 */
export function OnOff({ value, onChange, ariaLabel }: {
  value: boolean
  onChange: (value: boolean) => void
  ariaLabel: string
}) {
  const D = appConfig.copy.drawingEditor
  return (
    <Segmented ariaLabel={ariaLabel} value={value} onChange={onChange}
      options={[{ value: false, label: D.off }, { value: true, label: D.on }]} />
  )
}
