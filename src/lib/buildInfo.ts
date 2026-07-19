// Build stamp, injected at build time via vite `define` (see vite.config.ts).
// Surfaced in the app menu so a tablet in the field can be matched to a known deploy.
export const APP_VERSION = __APP_VERSION__
export const GIT_SHA = __GIT_SHA__
export const BUILD_TIME = __BUILD_TIME__

/** Compact, human-readable build label, e.g. "v0.1.0 · 922dba9 · 22.06.2026". */
export function buildLabel(): string {
  const date = new Date(BUILD_TIME)
  const d = isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
  return [`v${APP_VERSION}`, GIT_SHA, d].filter(Boolean).join(' · ')
}
