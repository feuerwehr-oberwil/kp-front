import { DEFAULT_INK } from './lineStyle'

/**
 * Read a live design token off `<html>`.
 *
 * For the handful of places that cannot use a CSS variable at all — MapLibre paint specs and
 * canvas/SVG attributes are the two — and would otherwise freeze a literal that stops following
 * the day/night flip or a re-themed deployment. Everything that CAN write `var(--token)` must.
 */
export function themeToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** The UI blue (`--blue`) as a literal — the transient chrome MapLibre paints (draft shape,
 *  measure path, the georef link tone) picks it up here instead of pairing hexes by hand.
 *  Re-read on every render; a component that must repaint on the flip watches `useNightTheme`. */
export const uiBlue = () => themeToken('--blue', DEFAULT_INK)
