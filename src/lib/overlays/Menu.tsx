import type { ReactElement, ReactNode } from 'react'
import { Menu as BaseMenu } from '@base-ui/react/menu'

/**
 * Anchored action menu — wraps Base UI's Menu. Base UI's Positioner does the
 * collision-aware anchoring (auto flip-up near a viewport edge) that surfaces hand-roll today,
 * and adds real keyboard nav (↑/↓, typeahead, Home/End, Esc) + focus management for free.
 *
 * The trigger keeps its own element/classes via `render`; Base UI wires aria-haspopup/expanded
 * and a `data-popup-open` attribute onto it (style the open trigger with `[data-popup-open]`).
 *
 * ⚠️ STACKING BELONGS ON THE POSITIONER, never on the popup. Base UI portals the popup to
 * <body> inside a Positioner it moves with a `transform` — and a transform makes that positioner
 * its own stacking context, so any `z-index` a caller puts on `popupClassName` is trapped inside
 * it and does nothing at all. That is not theory: on v0.6.0 every row action in the admin
 * (Bearbeiten, Rolle ändern, Deaktivieren, PIN zurücksetzen) opened INVISIBLE and unclickable
 * behind `.adm` (position:fixed, z-index:100), because `.adm-menu-portal { z-index: 1200 }` sat
 * on the popup. So the positioner carries a stable class — `.ui-menu-pos` — and the app's
 * stylesheet owns the one z-index (sibling to ContextMenu's `.ui-ctxmenu-pos`).
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

/** A one-of-N choice INSIDE the menu — a way of LOOKING at something, not a setting to flip.
 *  Unlike the checkbox rows it closes on pick: there is exactly one answer, so staying open would
 *  leave a menu over the thing whose arrangement was just changed. Real radio semantics rather
 *  than a column of checkboxes with one ticked, so it is announced as the single choice it is. */
export interface MenuRadioGroup<T extends string = string> {
  kind: 'radio'
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode; disabled?: boolean }[]
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
  items: (MenuActionItem | MenuCheckItem | MenuSeparator | MenuHeading | MenuRadioGroup)[]
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
  const renderItem = (it: MenuActionItem | MenuCheckItem | MenuRadioGroup, key: number) => {
    if ('kind' in it && it.kind === 'radio') {
      return (
        <BaseMenu.RadioGroup key={key} value={it.value} onValueChange={(v) => it.onChange(String(v))}>
          {it.options.map((o) => (
            <BaseMenu.RadioItem
              key={o.value}
              value={o.value}
              disabled={o.disabled}
              className={itemClassName ? itemClassName(false) : undefined}
            >
              <BaseMenu.RadioItemIndicator className="ui-menu-check ui-menu-radio" keepMounted>
                <svg viewBox="0 0 24 24" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
              </BaseMenu.RadioItemIndicator>
              {o.label}
            </BaseMenu.RadioItem>
          ))}
        </BaseMenu.RadioGroup>
      )
    }
    // `'kind' in it` alone: at this point the union is check|action and only the checkbox row
    // carries a `kind`, so the compound guard the old inline switch needed would leave TS unable
    // to narrow the fall-through to MenuActionItem.
    if ('kind' in it) {
      return (
        <BaseMenu.CheckboxItem
          key={key}
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
        key={key}
        className={itemClassName ? itemClassName(!!it.danger) : undefined}
        disabled={it.disabled}
        onClick={it.onClick}
      >
        {it.label}
        {it.disabled && it.reason != null && <span className={reasonClassName}>{it.reason}</span>}
      </BaseMenu.Item>
    )
  }

  // A heading OPENS A GROUP, it is not a row that happens to look like one. Base UI's GroupLabel
  // reads the id it has to announce out of the group's context and THROWS when there is none
  // («MenuGroupContext is missing») — a bare label crashed the whole app the moment the print
  // menu was opened. Grouping it properly is also the only version worth anything: the label is
  // what a screen reader announces for every row under it, so «Abschnitte» has to OWN the ticks
  // rather than merely precede them.
  // A rule does NOT close a group — it divides one. «Abschnitte» names nine sections that come in
  // three runs, and a group that ended at the first rule would leave six of them unnamed again,
  // which is the thing the heading was added to fix. Only the next heading closes a group; rows
  // before the first heading stay ungrouped, which is what an unlabelled block is.
  type Row = { it: MenuActionItem | MenuCheckItem | MenuRadioGroup; key: number } | { sep: true; key: number }
  const blocks: { label?: ReactNode; rows: Row[] }[] = []
  items.forEach((it, i) => {
    if ('kind' in it && it.kind === 'head') { blocks.push({ label: it.label, rows: [] }); return }
    if (!blocks.length) blocks.push({ rows: [] })
    blocks[blocks.length - 1].rows.push('kind' in it && it.kind === 'sep' ? { sep: true, key: i } : { it, key: i })
  })
  const renderRow = (r: Row) =>
    'sep' in r ? <BaseMenu.Separator key={r.key} className="ui-menu-sep" /> : renderItem(r.it, r.key)

  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="ui-menu-pos" side={side} align={align} sideOffset={sideOffset} collisionPadding={collisionPadding}>
          <BaseMenu.Popup className={popupClassName}>
            {blocks.map((b, i) => (
              // no label = nothing to associate, so no wrapper either — an extra div around the
              // rows would only add a box for the popup's own layout to reason about
              b.label == null
                ? b.rows.map(renderRow)
                : (
                  <BaseMenu.Group key={`g${i}`}>
                    <BaseMenu.GroupLabel className="ui-menu-head">{b.label}</BaseMenu.GroupLabel>
                    {b.rows.map(renderRow)}
                  </BaseMenu.Group>
                )
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}
