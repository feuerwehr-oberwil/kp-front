import type { ReactElement, ReactNode } from 'react'
import { Popover as BasePopover } from '@base-ui/react/popover'

/**
 * Anchored, non-modal popover — wraps Base UI's Popover. The Positioner anchors to the trigger
 * (collision-aware, auto-flips near a viewport edge), replacing hand-rolled
 * getBoundingClientRect math, and Base UI supplies outside-click + Esc dismissal and focus
 * management — so a hand-rolled full-screen scrim is no longer needed. The popup is portalled to
 * <body>, escaping any `backdrop-filter` containing block (the old reason the weather scrim was
 * trapped to the TopBar).
 *
 * Uncontrolled by default (the trigger toggles it); pass `open`/`onOpenChange` to control it.
 * NOTE: for surfaces that must NOT be dismissed/focus-managed and must let the map stay live
 * underneath (map tool-docks like MapViewsMenu), keep the hand-rolled dock — do not use this.
 */
export interface PopoverProps {
  trigger: ReactElement
  children: ReactNode
  ariaLabel?: string
  popupClassName?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  /** z-index for the (fixed) Positioner — set it to stack above surrounding fixed chrome. */
  zIndex?: number
  /** Keep-off distance from the viewport edge — the same default, and for the same reason, as
   *  overlays · Menu: Base UI's own 5px leaves a popover on a control near the edge sitting flush
   *  against it, and a panel of prose read flush to the glass reads as one that has been cut. On
   *  a phone the difference is not cosmetic — the Rapport's Kontrolle popover lost its first
   *  column of text off the left edge. A property of the surface being finite, not of a call site. */
  collisionPadding?: number
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Popover({ trigger, children, ariaLabel, popupClassName, side = 'bottom', align = 'end', sideOffset = 8, collisionPadding = 10, zIndex, open, onOpenChange }: PopoverProps) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={collisionPadding} style={zIndex != null ? { zIndex } : undefined}>
          {/* `ui-pop`: shared exit hook — see 13-incident.css [data-ending-style] */}
          <BasePopover.Popup className={popupClassName ? `ui-pop ${popupClassName}` : 'ui-pop'} aria-label={ariaLabel}>
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}

/** A control inside a <Popover> that closes it. Merges onto a native button. */
export function PopoverClose({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return <BasePopover.Close className={className} onClick={onClick}>{children}</BasePopover.Close>
}
