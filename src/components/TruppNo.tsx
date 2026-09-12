import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'

/**
 * The small number beside a Trupp's leader name — «Trupp 3» as documentation, never as identity
 * (docs/trupp-naming.md §2): people call a Trupp by its Gruppenführer, so the name stays primary
 * on the card, the phone row, the lite tab, the plan chip and the map marker, and this badge is
 * what a Verlauf row or the Rapport can be matched against. Renders nothing for a record that
 * has no number yet (one merged in from an older device before the load normaliser saw it).
 */
export function TruppNo({ no, className }: { no?: number; className?: string }) {
  if (typeof no !== 'number') return null
  return <span className={cx('trupp-no', className)} title={`${appConfig.copy.whiteboard.team} ${no}`}>{no}</span>
}
