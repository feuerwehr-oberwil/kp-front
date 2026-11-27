import { DEFAULT_INK } from './lineStyle'

/** the token values read under `cacheKey`; cleared whenever the key changes */
const cache = new Map<string, string>()
let cacheKey = ''

/** What decides a token's value on `<html>`: the theme attribute (`applyTheme`), the inline style
 *  (the deployment branding sets `--accent` there) and the sheets loaded so far. All three are plain
 *  reads – none of them forces a style recalc. */
const styleKey = (root: HTMLElement) =>
  `${root.dataset.theme ?? ''}|${root.getAttribute('style') ?? ''}|${document.styleSheets.length}`

/**
 * Read a live design token off `<html>`.
 *
 * For the handful of places that cannot use a CSS variable at all — MapLibre paint specs and
 * canvas/SVG attributes are the two — and would otherwise freeze a literal that stops following
 * the day/night flip or a re-themed deployment. Everything that CAN write `var(--token)` must.
 *
 * Each token is read once per `styleKey`: `getComputedStyle` on a dirty style tree is a forced
 * recalc, and the callers sit in the render of the two biggest components. The key is checked on
 * every call, so the first render after a flip already gets the new value. An empty read (the
 * stylesheet is not there yet) returns the fallback and is not kept.
 */
export function themeToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const root = document.documentElement
  const key = styleKey(root)
  if (key !== cacheKey) { cache.clear(); cacheKey = key }
  let value = cache.get(name)
  if (value === undefined) {
    value = getComputedStyle(root).getPropertyValue(name).trim()
    if (value) cache.set(name, value)
  }
  return value || fallback
}

/** The UI blue (`--blue`) as a literal — the transient chrome MapLibre paints (draft shape,
 *  measure path, the georef link tone) picks it up here instead of pairing hexes by hand.
 *  Cheap to call in render; a component that must repaint on the flip watches `useNightTheme`. */
export const uiBlue = () => themeToken('--blue', DEFAULT_INK)
