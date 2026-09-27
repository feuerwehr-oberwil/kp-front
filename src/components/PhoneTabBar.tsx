import type { ReactNode } from 'react'
import { Segmented } from './Segmented'

/**
 * THE phone's docked tab strip: a <Segmented> fixed just above the nav bar, in the bar's glass,
 * the width of the bars (15-mobile.css · `.rp-tabs`). The Rapport had it first (Bericht ·
 * Personal & Mittel · Beilagen, 19.09.2026); the Anwesenheit's three readings (Anwesenheit ·
 * Zeitplan · Schichten) joined on 27.09.2026 — owner: «move the anwesenheit / zeitplan /
 * schichten toggle also to the bottom → same as for the einsatzrapport». One component so the
 * two cannot drift: the class is the one every lane rule keys on (`--rp-tabs-safe`, the
 * floating row's baseline, the surface shell's bottom inset), and a page that renders this
 * gets all of that reserved for it by `:has(.rp-tabs)`.
 *
 * ⚠️ PHONE ONLY by stylesheet: `.rp-tabs` is `display: none` from 601px up (13-incident.css).
 * The Rapport renders it at every width so the tab STATE always exists; the Anwesenheit renders
 * it only on a phone because its tablet head carries the same <Segmented> inline. Either way
 * the switch is the caller's — this is the bar, not the tabs.
 */
export function PhoneTabBar<T extends string>({ ariaLabel, value, onChange, options }: {
  ariaLabel: string
  value: T
  onChange: (value: T) => void
  options: readonly { value: T; label: ReactNode; title?: string }[]
}) {
  return (
    <div className="rp-tabs">
      <Segmented<T> ariaLabel={ariaLabel} value={value} onChange={onChange} options={options} />
    </div>
  )
}
