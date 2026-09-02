import { useEffect, useRef } from 'react'
import { reportClientError } from './reportError'
import { recordTrouble } from './trouble'

// A render storm that never throws is invisible to every guard the app has: `Maximum update
// depth exceeded` lands in the ErrorBoundary and counts as a crash, but the mediaQueue storm of
// August (~900 commits/s) kept the UI fully «working» while it drained the battery, and nothing
// in the tree noticed. This is the smoke detector for that shape — diagnostics only, it changes
// no behaviour: one client-error beacon (reportError is capped + deduped anyway) and a trouble
// record so the Rückmeldung asks about it on the launcher.

/** commits inside one window that count as a storm — an honest re-render burst (a poll adopting
 *  rows, a drag) stays far below this, the mediaQueue storm was ~10× above it per window */
export const STORM_COMMITS = 200
export const STORM_WINDOW_MS = 2000

/**
 * Pure sliding-window counter: `commit()` returns true exactly ONCE, on the commit that fills
 * the window. The window restarts from the first commit after `windowMs` of quiet, so a slow
 * steady trickle never accumulates into a false alarm.
 */
export function createStormDetector(
  threshold = STORM_COMMITS,
  windowMs = STORM_WINDOW_MS,
  now: () => number = Date.now,
) {
  let start = 0
  let count = 0
  let tripped = false
  return {
    commit(): boolean {
      const t = now()
      if (t - start > windowMs) { start = t; count = 0 }
      count += 1
      if (tripped || count < threshold) return false
      tripped = true
      return true
    },
  }
}

// once per session per label — a wedged component must not report on every remount either
const reported = new Set<string>()

/**
 * Count this component's commits and report a storm once. Mount with one line in the component
 * whose re-render is the expensive one (IncidentWorkspace); the effect itself is a ref bump.
 */
export function useRenderStorm(label: string): void {
  const detector = useRef<ReturnType<typeof createStormDetector> | null>(null)
  useEffect(() => {
    if (!detector.current) detector.current = createStormDetector()
    if (!detector.current.commit() || reported.has(label)) return
    reported.add(label)
    reportClientError(new Error(`render storm: ${label}`), { kind: 'render' })
    recordTrouble('renderStorm')
  })
}
