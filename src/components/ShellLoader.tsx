/*
 * In-workspace activity uses `ShellLoader` / `LoadingStatus` (01.10.2026): the compact
 * Shell trail draws the SVG's `fs-shell-trail` spiral in inherited ink, with a 2.4 s loop
 * and a static reduced-motion state. Keep the path in the mascot SVG, never copy its geometry.
 * Use the decorative loader inside busy actions, or `LoadingStatus` beside existing loading
 * copy. Do not add artificial minimum waits for in-app activity.
 */

import type { ReactNode } from 'react'
import snailSvg from '../../public/firefighter-snail-loader.svg?raw'
import s from './ShellLoader.module.css'

// The compact loader traces the mascot's own spiral, rather than maintaining another drawing.
const shellPath = snailSvg.match(/<path id="fs-shell-trail" d="([^"]+)"/)?.[1]
if (!shellPath) throw new Error('Loading mascot is missing its shell trail')

type Size = 'inline' | 'surface'

export function ShellLoader({ size = 'inline' }: { size?: Size }) {
  return <svg className={`${s.loader} ${size === 'surface' ? s.surface : ''}`} viewBox="480 245 270 315" width={size === 'surface' ? 48 : 20} height={size === 'surface' ? 48 : 20}
    fill="none" stroke="currentColor" strokeWidth="14" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d={shellPath} opacity=".12" />
    <path d={shellPath} pathLength="100" className={s.trail} />
  </svg>
}

/** The words announce the wait; the spiral is decorative. The caller owns placement. */
export function LoadingStatus({ children, size = 'inline' }: { children: ReactNode; size?: Size }) {
  return <span className={`${s.status} ${size === 'surface' ? s.stacked : ''}`} role="status">
    <ShellLoader size={size} /><span>{children}</span>
  </span>
}
