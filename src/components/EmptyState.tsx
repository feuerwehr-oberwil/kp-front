import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'

/**
 * Shared empty state for destination surfaces (a modal/panel you navigated to that is
 * genuinely empty). Per the 3am tenet, an empty surface should *teach* what it's for and
 * offer the way forward — an icon + headline, an optional explaining line, and an optional
 * action. «No hits» is NOT this: a search that came back empty is the one `.no-hits` line
 * (`copy.noHits`, or `copy.filterNoHits` while only a filter narrows the list) – docs/ui-conventions.md
 * › No hits. EmptyState is for a list with nothing in it yet.
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
