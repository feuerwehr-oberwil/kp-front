// Build stamp, injected at build time via vite `define` (see vite.config.ts).
// Surfaced in the app menu so a tablet in the field can be matched to a known deploy.
export const APP_VERSION = __APP_VERSION__
export const GIT_SHA = __GIT_SHA__
export const BUILD_TIME = __BUILD_TIME__

/** Compact, human-readable build label, e.g. "v0.1.0 · 922dba9 · 22.06.2026". */
export function buildLabel(): string {
  const date = new Date(BUILD_TIME)
  // a technical identifier, matched against a deploy by whoever reads it, so ONE spelling on every
  // station whatever its language: dd.mm.yyyy, spelled out rather than borrowed from a locale (it
  // was a literal 'de-CH', which printed exactly this). No lib/format import: this module sits
  // under reportError and swUpdate, at the bottom of the boot graph.
  const p2 = (n: number) => String(n).padStart(2, '0')
  const d = isNaN(date.getTime())
    ? ''
    : `${p2(date.getDate())}.${p2(date.getMonth() + 1)}.${date.getFullYear()}`
  return [`v${APP_VERSION}`, GIT_SHA, d].filter(Boolean).join(' · ')
}
