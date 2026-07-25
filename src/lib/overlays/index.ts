// Shared overlay primitives — the ONLY module that imports @base-ui/react directly. Every app
// surface uses these wrappers so behavior, theming, and the a11y contract live in one place.
// The non-modal map tool-docks stay hand-rolled on purpose — see AGENTS.md ("Overlays go
// through src/lib/overlays/") for which surfaces are deliberately excluded and why.
export { Sheet, SheetClose, type SheetProps } from './Sheet'
export { Overlay, type OverlayProps } from './Overlay'
export { ConfirmCard } from './ConfirmCard'
export { Menu, type MenuActionItem } from './Menu'
export { Popover, PopoverClose, type PopoverProps } from './Popover'
