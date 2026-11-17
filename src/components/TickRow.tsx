import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import s from './TickRow.module.css'

// THE «item ticked off» control (20.10.2026, UX sweep F7, owner: «shared primitive yes … the blue,
// not green»): the box and its label are ONE button, ≥44px on every pointer, `role="checkbox"` +
// `aria-checked` (Space and Enter come with the button). Ticked = the choice fill (`--sel` box,
// `--on-sel` ✓); unticked = an empty framed box — never a «−», never a green. Used where a list's
// items are worked off: the Checkliste, the Rapport's Partnerorganisationen and «Formulare &
// Links», the Tafel's «erledigt» column (there without `children`: a 44px square, named by
// `aria-label`). Picking ITEMS as the answer to a question (the Trupp's Ausrüstung) is a `Chip`.
// What a ticked row MEANS beyond the box (a Checkliste item fades, a Tafel row is struck through)
// stays the surface's; `className` places the row, it never re-skins the box. `disabled` makes the
// row a READ-OUT (full opacity, no tap) for a session that cannot tick – never a faded door.
// A PENDENZ is ticked with it too, on every surface (duck sweep ELEM.2/ENT.5, 17.11.2026): the
// Verlauf row, the pinned «Offene Pendenzen» block, the Tafel, the legend. `pendenz` names the
// open item's state, and the UNTICKED box's frame says it – amber «offen», red «überfällig», red
// with the drawn «!» «dringend»; ticked is the one blue «erledigt» whatever it was. A tap ticks,
// a second tap reopens; both are logged by the caller (useReminders · setDone).

type TickRowProps = Omit<ComponentPropsWithRef<'button'>, 'role' | 'aria-checked' | 'aria-pressed' | 'onClick' | 'onChange'> & {
  checked: boolean
  onToggle: () => void
  /** the visible label — any phrasing content; leave it out for a box alone (then `aria-label`) */
  children?: ReactNode
  /** a Pendenz's state while open: tones the unticked frame (see above) */
  pendenz?: PendenzState
}

/** An open Pendenz's state, as its tick box draws it (TickRow · `pendenz`). */
export type PendenzState = 'open' | 'urgent' | 'overdue'

export function TickRow({ checked, onToggle, children, className, pendenz, type = 'button', ...rest }: TickRowProps) {
  return (
    <button
      type={type}
      role="checkbox"
      aria-checked={checked}
      className={cx(s.row, children == null && s.solo, className)}
      onClick={onToggle}
      {...rest}
    >
      <TickBox checked={checked} pendenz={pendenz} />
      {children}
    </button>
  )
}

/** The box alone, as a READ-OUT where a row is no control (the Verlauf legend and filter menu, a
 *  done row in the log, a session without a hand to tick): the same box, the same state frame. */
export function TickBox({ checked, pendenz, className }: { checked: boolean; pendenz?: PendenzState; className?: string }) {
  return (
    <span className={cx(s.box, checked && s.boxOn, className)} data-pendenz={pendenz && (checked ? 'done' : pendenz)} aria-hidden="true">
      {checked ? <Icon id="check" /> : pendenz === 'urgent' && <i className={s.bang} />}
    </span>
  )
}
