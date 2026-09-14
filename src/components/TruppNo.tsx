import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'

/**
 * The small number beside a Trupp's leader name — «Trupp 3» as documentation, never as identity
 * (docs/trupp-naming.md §2): people call a Trupp by its Gruppenführer, so the name stays primary
 * on the card, and this badge is what a Verlauf row or the Rapport can be matched against. Not on
 * the phone row, the lite tab strip, or (14.09.) the resting Trupp marker on the Karte and chip on
 * the Plan — there the name alone is the label, and the number lives on the Atemschutz card.
 * Renders nothing for a record that has no number yet (one merged in from an older device before
 * the load normaliser saw it).
 *
 * ⚠️ «#1», not a bare «1» (Bastian, 12.09.): beside a name a lone digit read as a COUNT — how
 * many Trupps there are — and the badge is an identifier. The «#» says so without a word to
 * learn; the full «Trupp 1» is in the title for hover and in the journal rows themselves.
 */
export function TruppNo({ no, className }: { no?: number; className?: string }) {
  if (typeof no !== 'number') return null
  return <span className={cx('trupp-no', className)} title={`${appConfig.copy.whiteboard.team} ${no}`}>#{no}</span>
}
