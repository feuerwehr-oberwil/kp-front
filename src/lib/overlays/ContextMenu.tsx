import type { ReactElement, ReactNode } from 'react'
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'

/**
 * Right-click menu on a planning surface — the explicit alternative to a tap that cycles.
 *
 * The Zeitplan bars and the Schichten cells advance to «whatever is next» when tapped, which is
 * right on a tablet at the scene (one thumb, no menus) and wrong at a desk while planning: you
 * have to know the order to land on the state you want, and correcting an overshoot means
 * cycling all the way round. So the tap stays exactly as it is and this sits beside it, naming
 * every state with the current one ticked, plus the two things a cycle can never offer —
 * «Bearbeiten» and «Entfernen».
 *
 * Base UI's own ContextMenu, not a hand-rolled popover: it brings the pointer anchoring, the
 * flip near a viewport edge, Esc/outside-click dismissal, focus restore and the ARIA roles that
 * a menu opened by right-click needs and that would otherwise all be re-implemented here.
 * Like every other overlay, the dependency is imported ONLY inside this folder.
 */

export interface ContextMenuEntry {
  label: ReactNode
  onClick?: () => void
  /** renders in the danger tone (Entfernen) */
  danger?: boolean
  disabled?: boolean
  /** one of a set of states: shows a tick when true. Adjacent `checked` entries read as a group. */
  checked?: boolean
  /** draw a rule above this entry — separating «what state is it» from «what can I do to it» */
  separatorBefore?: boolean
}

export function ContextMenu({ trigger, items, disabled }: {
  /** the element that owns the right-click; rendered as-is, keeping its own classes/handlers */
  trigger: ReactElement
  items: ContextMenuEntry[]
  /** no menu at all — a read-only surface, or a touch device where the tap cycle is the model
   *  and Base UI's long-press would fight the drag gestures these surfaces already use */
  disabled?: boolean
}) {
  if (disabled || items.length === 0) return trigger
  return (
    <BaseContextMenu.Root>
      <BaseContextMenu.Trigger render={trigger} />
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner className="ui-ctxmenu-pos">
          <BaseContextMenu.Popup className="ui-pop ui-ctxmenu">
            {items.map((it, i) => (
              <BaseContextMenu.Item
                key={i}
                className={`ui-ctxmenu-item${it.danger ? ' danger' : ''}${it.checked ? ' on' : ''}`}
                disabled={it.disabled}
                onClick={it.onClick}
                data-sep={it.separatorBefore ? '' : undefined}
              >
                {/* the tick sits in a fixed slot so labels line up whether or not one is set —
                    a list that shifts sideways as the state changes is hard to read at a glance */}
                <span className="ui-ctxmenu-tick" aria-hidden>{it.checked ? '✓' : ''}</span>
                {it.label}
              </BaseContextMenu.Item>
            ))}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  )
}
