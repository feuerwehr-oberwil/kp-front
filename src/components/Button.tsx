import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from '../lib/cx'
import s from './Button.module.css'

// THE button (07.10.2026, UI sweep C4) — see Button.module.css for why it exists. New buttons use
// <Button>/<IconButton> (and <Chip> for a choice); a surface's own class goes in `className` for
// PLACEMENT (margin, grid area), never to restyle the look — a second look is a new variant here.
//
// · `type` defaults to "button": a bare <button> inside a <form> submits it, and nothing in this
//   app wants that by accident. Pass type="submit" where it does.
// · React 19 passes `ref` as a prop, so both take one without forwardRef.

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'go'

type ButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children'> & {
  /** primary: the one action of a form/sheet · secondary (default): the others · quiet: a word on
   *  the surface («Später») · danger: THE delete look, a red outline · go: the primary whose move
   *  KEEPS things safely as they are, filled green (the Meldeleiste's «Am Einsatzort lassen») */
  variant?: ButtonVariant
  /** md (default) = 44px, the gloved floor · lg = 52px, the one big action of a screen */
  size?: 'md' | 'lg'
  /** full width of its container */
  block?: boolean
  /** a leading glyph (an <Icon/>) */
  icon?: ReactNode
  children: ReactNode
}

// ⚠️ Its LOOK is the global `.ip-btn` family (13-incident.css · «THE button»), not a module class:
// ONE definition for <Button> and for the ~150 `.ip-btn` the TSX still writes by hand (some on a
// <label> or an <a>), so the two cannot drift apart (08.10.2026, design-system stage 2).
export function Button({ variant = 'secondary', size = 'md', block, icon, className, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('ip-btn', variant !== 'secondary' && variant, size === 'lg' && 'lg', block && 'block', className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  /** REQUIRED: the button's word. It is the accessible name and the hover/hold tooltip
   *  (lib/holdTooltip reads it) — an icon-only button that cannot say what it does is a guess at 3am. */
  label: string
  /** the glyph — an <Icon/> */
  children: ReactNode
  /** quiet (default): glyph on the surface · secondary: the surface and its hairline, for a
   *  control standing free on a bar or the map */
  variant?: 'quiet' | 'secondary'
}

export function IconButton({ label, variant = 'quiet', className, type = 'button', title, children, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cx(s.icon, variant === 'secondary' && s.iconSecondary, className)}
      {...rest}
    >
      {children}
    </button>
  )
}
