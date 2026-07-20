// Shared overlay primitives — the ONLY module that imports @base-ui/react directly. Every app
// surface uses these wrappers so behavior, theming, and the a11y contract live in one place.
// See docs/planning/base-ui-adoption.md.
export { Sheet, SheetClose, type SheetProps } from './Sheet'
export { Overlay, type OverlayProps } from './Overlay'
