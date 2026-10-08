import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from '../lib/cx'
import s from './Chip.module.css'

// THE choice chip (07.10.2026, UI sweep C4) — see Chip.module.css. `selected` draws the chosen
// look AND says it: aria-pressed, so a screen reader hears «gedrückt» where the eye sees blue.
// Leave it undefined for a chip that is an action, not a choice (no aria-pressed then).

type ChipProps = Omit<ComponentPropsWithRef<'button'>, 'children'> & {
  selected?: boolean
  /** a leading glyph (an <Icon/>) */
  icon?: ReactNode
  children: ReactNode
}

export function Chip({ selected, icon, className, type = 'button', children, ...rest }: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={cx(s.chip, selected && s.on, className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
