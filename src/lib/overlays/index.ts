// Shared overlay primitives — the ONLY module that imports @base-ui/react directly. Every app
// surface uses these wrappers so behavior, theming, and the a11y contract live in one place.
// The non-modal map tool-docks stay hand-rolled on purpose — see AGENTS.md ("Overlays go
// through src/lib/overlays/") for which surfaces are deliberately excluded and why.
export { Sheet, SheetClose, type SheetProps } from './Sheet'
export { Overlay, type OverlayProps } from './Overlay'
// for the ONE hand-rolled bottom sheet (components/Palette): the same bar, the same gesture
export { SheetGrab } from './SheetGrab'
// the one NON-modal phone sheet: peek · half · full over a live surface (the Suche)
export { DetentSheet, type Detent } from './DetentSheet'
export { useSwipeDismiss } from './swipeDismiss'
export { ConfirmCard } from './ConfirmCard'
export { Menu, type MenuActionItem } from './Menu'
export { ContextMenu, type ContextMenuEntry } from './ContextMenu'
export { Popover, PopoverClose, type PopoverProps } from './Popover'
// a hand-rolled dropdown that can open over a Sheet/Overlay registers here, so the sheet's
// backdrop/Esc dismissal stands down while it is open
export { usePopoverGuard, popoverOpen, resetPopoverGuard } from './popoverGuard'
