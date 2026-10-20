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
// stays the surface's; `className` places the row, it never re-skins the box.

type TickRowProps = Omit<ComponentPropsWithRef<'button'>, 'role' | 'aria-checked' | 'aria-pressed' | 'onClick' | 'onChange'> & {
  checked: boolean
  onToggle: () => void
  /** the visible label — any phrasing content; leave it out for a box alone (then `aria-label`) */
  children?: ReactNode
}

export function TickRow({ checked, onToggle, children, className, type = 'button', ...rest }: TickRowProps) {
  return (
    <button
      type={type}
      role="checkbox"
      aria-checked={checked}
      className={cx(s.row, children == null && s.solo, checked && s.on, className)}
      onClick={onToggle}
      {...rest}
    >
      <span className={s.box} aria-hidden="true">{checked && <Icon id="check" />}</span>
      {children}
    </button>
  )
}
