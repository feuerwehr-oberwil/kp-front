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
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Popover({ trigger, children, ariaLabel, popupClassName, side = 'bottom', align = 'end', sideOffset = 8, zIndex, open, onOpenChange }: PopoverProps) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} style={zIndex != null ? { zIndex } : undefined}>
          <BasePopover.Popup className={popupClassName} aria-label={ariaLabel}>
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
