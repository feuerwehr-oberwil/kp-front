import type { ReactElement, ReactNode } from 'react'
import { Menu as BaseMenu } from '@base-ui/react/menu'

/**
 * Anchored action menu — wraps Base UI's Menu. Base UI's Positioner does the
 * collision-aware anchoring (auto flip-up near a viewport edge) that surfaces hand-roll today,
 * and adds real keyboard nav (↑/↓, typeahead, Home/End, Esc) + focus management for free.
 *
 * The trigger keeps its own element/classes via `render`; Base UI wires aria-haspopup/expanded
 * and a `data-popup-open` attribute onto it (style the open trigger with `[data-popup-open]`).
 */
export interface MenuActionItem {
  label: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  /** shown as a small reason line under a disabled item (native title never shows when disabled) */
  reason?: ReactNode
}

export function Menu({ trigger, items, popupClassName, itemClassName, reasonClassName, side = 'bottom', align = 'end', sideOffset = 4 }: {
  trigger: ReactElement
  items: MenuActionItem[]
  popupClassName?: string
  /** class for each item; receives whether the item is `danger`. */
  itemClassName?: (danger: boolean) => string
  reasonClassName?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={sideOffset}>
          <BaseMenu.Popup className={popupClassName}>
            {items.map((it, i) => (
              <BaseMenu.Item
                key={i}
                className={itemClassName ? itemClassName(!!it.danger) : undefined}
                disabled={it.disabled}
                onClick={it.onClick}
              >
                {it.label}
                {it.disabled && it.reason != null && <span className={reasonClassName}>{it.reason}</span>}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}
