import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'

/**
 * Shared empty state for destination surfaces (a modal/panel you navigated to that is
 * genuinely empty). Per the 3am tenet, an empty surface should *teach* what it's for and
 * offer the way forward — an icon + headline, an optional explaining line, and an optional
 * action. Transient "no search hits" results stay terse (.ip-ac-note) and don't use this.
 */
export function EmptyState({ icon, title, sub, action, className }: {
  icon?: string
  title: string
  sub?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ''}`}>
      {icon && <span className="empty-state-icon"><Icon id={icon} /></span>}
      <div className="empty-state-title">{title}</div>
      {sub && <div className="empty-state-sub">{sub}</div>}
      {action && <div className="empty-state-act">{action}</div>}
    </div>
  )
}
