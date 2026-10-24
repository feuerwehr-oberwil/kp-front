// Shared overlay primitives — the ONLY module that imports @base-ui/react directly. Every app
// surface uses these wrappers so behavior, theming, and the a11y contract live in one place.
// The non-modal map tool-docks stay hand-rolled on purpose — see docs/ui-conventions.md · Overlays
// for which surfaces are deliberately excluded and why.

// Rules for this area that span modules: docs/ui-conventions.md · «Overlays».

export { Sheet, SheetClose } from './Sheet'
export { Overlay } from './Overlay'
// for the ONE hand-rolled bottom sheet (components/Palette): the same bar, the same gesture
export { SheetGrab } from './SheetGrab'
// the footer row of a bespoke bottom-sheet frame — the same insets <Sheet>'s own footer pays
export { SheetFoot } from './SheetFoot'
export { useSwipeDismiss } from './swipeDismiss'
export { Menu, type MenuActionItem } from './Menu'
export { ContextMenu } from './ContextMenu'
export { Popover, PopoverClose } from './Popover'
