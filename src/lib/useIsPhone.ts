import { useEffect, useState } from 'react'

/** Reactive `matchMedia` — the one place the resize/orientation plumbing lives, so a surface that
 *  needs its own threshold doesn't hand-roll the same effect. Query must be a constant. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatches(mq.matches)
    setMatches(mq.matches)   // the query can change between render and effect
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

// True on phone-sized screens. On phones the app is a live VIEWER + field capture: the
// tactical editing tools are locked (see `tacticalLocked` in App), but a editor can still view
// the live Lage and add journal entries / photos / voice memos.
// Reactive to resize + orientation change.
//
// ⚠️ TWO conditions, not one width. A phone TURNED SIDEWAYS is 800–960px wide and used to fall
// straight through to the desktop layout — the full top bar and both rails on a viewport barely
// 400px tall, which is the one shape they cannot work in. So a short landscape viewport counts
// as a phone — up to 1000px wide.
//
// ⚠️ The 1000px bound is what keeps a TABLET out of the clause. Under the old `interactive-
// widget=resizes-content` (index.html, until 28.08.) the software keyboard shrank the LAYOUT
// viewport, so a tablet in landscape with a field focused was a 1180×440 viewport — short,
// landscape, and for exactly as long as the keyboard stood, a «phone»: every modal snapped to
// the full-width bottom-sheet layout the moment the Journaleintrag or the symbol search took
// focus, and snapped back on blur. `overlays-content` ended that shrink, but the width bound
// keeps its job: the largest phones are ~960px sideways, the smallest tablets 1024, and width
// is the dimension that separates them regardless of what the keyboard does.
//
// ⚠️ This string is the JS half of a rule the stylesheets carry too — the same trio of
// conditions heads every phone `@media` block in src/styles and the CSS modules. They decide the
// same layout from two places and MUST be changed together; a JS/CSS disagreement here means a
// phone bottom sheet inside a desktop shell.
export const PHONE_QUERY = '(max-width: 600px), (orientation: landscape) and (max-height: 520px) and (max-width: 1000px)'

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY)
}
