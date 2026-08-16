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

// True on phone-sized screens (≤ 600px). On phones the app is a live VIEWER + field
// capture: the tactical editing tools are locked (see `tacticalLocked` in App), but a
// editor can still view the live Lage and add journal entries / photos / voice memos.
// Reactive to resize + orientation change.
const QUERY = '(max-width: 600px)'

export function useIsPhone(): boolean {
  return useMediaQuery(QUERY)
}
