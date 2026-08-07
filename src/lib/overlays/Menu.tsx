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
/** A checkbox row INSIDE the menu — for settings you want to flip without leaving it. Base UI
 *  keeps the menu open on a checkbox click, which is the whole point: «what goes on the paper»
 *  is several decisions in a row, and a menu that closes after each one is a menu you reopen. */
export interface MenuCheckItem {
  kind: 'check'
  label: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

/** A rule between groups of items. */
export interface MenuSeparator { kind: 'sep' }

/** A group label. A menu that mixes an action with a block of settings has to say which is
 *  which — a column of ticks under a print button, with nothing naming them, is a menu you have
 *  to experiment with. */
export interface MenuHeading { kind: 'head'; label: ReactNode }

export interface MenuActionItem {
  label: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  /** shown as a small reason line under a disabled item (native title never shows when disabled) */
  reason?: ReactNode
}

export function Menu({ trigger, items, popupClassName, itemClassName, reasonClassName, side = 'bottom', align = 'end', sideOffset = 4, collisionPadding = 10 }: {
  trigger: ReactElement
  items: (MenuActionItem | MenuCheckItem | MenuSeparator | MenuHeading)[]
  popupClassName?: string
  /** class for each item; receives whether the item is `danger`. */
  itemClassName?: (danger: boolean) => string
  reasonClassName?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  /** Keep-off distance from the viewport edge. Without it a wide menu on a control near the right
   *  edge is positioned flush to that edge and can render half off screen — which is exactly what
   *  the Rapport's print menu did on a tablet. Applies to every Menu in the app on purpose: this
   *  is a property of the surface being finite, not of any one call site. */
  collisionPadding?: number
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={collisionPadding}>
          <BaseMenu.Popup className={popupClassName}>
            {items.map((it, i) => {
              if ('kind' in it && it.kind === 'sep') return <BaseMenu.Separator key={i} className="ui-menu-sep" />
              if ('kind' in it && it.kind === 'head') return <BaseMenu.GroupLabel key={i} className="ui-menu-head">{it.label}</BaseMenu.GroupLabel>
              if ('kind' in it && it.kind === 'check') {
                return (
                  <BaseMenu.CheckboxItem
                    key={i}
                    className={itemClassName ? itemClassName(false) : undefined}
                    checked={it.checked}
                    disabled={it.disabled}
                    onCheckedChange={it.onChange}
                    closeOnClick={false}
                  >
                    <BaseMenu.CheckboxItemIndicator className="ui-menu-check" keepMounted>
                      <svg viewBox="0 0 24 24" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
                    </BaseMenu.CheckboxItemIndicator>
                    {it.label}
                  </BaseMenu.CheckboxItem>
                )
              }
              return (
                <BaseMenu.Item
                  key={i}
                  className={itemClassName ? itemClassName(!!it.danger) : undefined}
                  disabled={it.disabled}
                  onClick={it.onClick}
                >
                  {it.label}
                  {it.disabled && it.reason != null && <span className={reasonClassName}>{it.reason}</span>}
                </BaseMenu.Item>
              )
            })}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}
