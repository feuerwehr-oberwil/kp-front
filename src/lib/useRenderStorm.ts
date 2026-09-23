import { useEffect, useRef } from 'react'
import { reportClientError } from './reportError'
import { recordTrouble } from './trouble'

// A render storm that never throws is invisible to every guard the app has: `Maximum update
// depth exceeded` lands in the ErrorBoundary and counts as a crash, but the mediaQueue storm of
// August (~900 commits/s) kept the UI fully «working» while it drained the battery, and nothing
// in the tree noticed. This is the smoke detector for that shape — diagnostics only, it changes
// no behaviour: one client-error beacon per storm and a trouble record so the Rückmeldung asks
// about it on the launcher.
//
// ⚠️ The beacon says WHERE and WHAT (24.09.2026). «render storm: IncidentWorkspace» was all the
// log had on 23.09., once per page load: which surface was open, how fast it spun and which state
// kept changing had to be reconstructed from the database afterwards, and a second storm later in
// the same page load (the «Weiter folgen» one at 20:31) could not be reported at all. So the
// caller names its context (the open tab) and a handful of values to WATCH — compared by identity
// on every commit, a few `Object.is` calls, the cheapest thing that answers «which state is
// looping» — and the detector re-arms after STORM_QUIET_MS without a storm.

/** commits inside one window that count as a storm — an honest re-render burst (a poll adopting
 *  rows, a drag) stays far below this, the mediaQueue storm was ~10× above it per window */
export const STORM_COMMITS = 200
export const STORM_WINDOW_MS = 2000
/** a storm has to have been over this long before the next one is reported again */
export const STORM_QUIET_MS = 60_000

/**
 * Pure sliding-window counter: `commit()` returns true exactly ONCE per storm, on the commit that
 * fills the window. The window restarts from the first commit after `windowMs` of quiet, so a
 * slow steady trickle never accumulates into a false alarm; and once no window has been full for
 * `quietMs` the detector re-arms, so the NEXT storm in the same page load is a report of its own.
 */
export function createStormDetector(
  threshold = STORM_COMMITS,
  windowMs = STORM_WINDOW_MS,
  now: () => number = Date.now,
  quietMs = STORM_QUIET_MS,
) {
  let start = 0
  let count = 0
  let tripped = false
  /** the last commit that sat in a full window — «the storm is still going» */
  let stormAt = 0
  return {
    commit(): boolean {
      const t = now()
      if (tripped && t - stormAt >= quietMs) tripped = false
      if (t - start > windowMs) { start = t; count = 0 }
      count += 1
      if (count >= threshold) stormAt = t
      if (tripped || count < threshold) return false
      tripped = true
      return true
    },
    /** the current window: when it started, how many commits, how long so far */
    window(): { start: number; commits: number; ms: number } {
      return { start, commits: count, ms: now() - start }
    },
  }
}

/** One label's storms, across remounts — a wedged component must not report on every remount. */
const lastReported = new Map<string, number>()

export interface RenderStormContext {
  /** where the app stood, e.g. `tab=map` — goes into the report verbatim */
  context?: string
  /** values to compare by identity on every commit; the report names the ones that kept changing */
  watch?: Record<string, unknown>
}

/** «objects×198, layers×2» — the watched values that changed in this window, busiest first. */
export function changedSummary(counts: Record<string, number>, max = 5): string {
  const busy = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, max)
  return busy.length ? busy.map(([k, n]) => `${k}×${n}`).join(', ') : 'none of the watched values'
}

/**
 * Count this component's commits and report a storm. Mount with one line in the component whose
 * re-render is the expensive one (IncidentWorkspace); the effect itself is a ref bump plus one
 * identity check per watched value.
 */
export function useRenderStorm(label: string, opts: RenderStormContext = {}): void {
  const detector = useRef<ReturnType<typeof createStormDetector> | null>(null)
  const prev = useRef<Record<string, unknown> | null>(null)
  const changes = useRef<{ start: number; counts: Record<string, number> }>({ start: -1, counts: {} })
  useEffect(() => {
    if (!detector.current) detector.current = createStormDetector()
    const tripped = detector.current.commit()
    const win = detector.current.window()
    const { watch } = opts
    if (watch) {
      if (changes.current.start !== win.start) changes.current = { start: win.start, counts: {} }
      const before = prev.current
      if (before) {
        const counts = changes.current.counts
        for (const k of Object.keys(watch)) if (!Object.is(before[k], watch[k])) counts[k] = (counts[k] ?? 0) + 1
      }
      prev.current = watch
    }
    if (!tripped) return
    const now = Date.now()
    const last = lastReported.get(label)
    if (last !== undefined && now - last < STORM_QUIET_MS) return
    lastReported.set(label, now)
    const parts = [
      `render storm: ${label}`,
      ...(opts.context ? [opts.context] : []),
      `${win.commits} commits in ${win.ms} ms`,
      ...(watch ? [`changed: ${changedSummary(changes.current.counts)}`] : []),
    ]
    reportClientError(new Error(parts.join(' · ')), { kind: 'render-storm' })
    recordTrouble('renderStorm')
  })
}

/** Test-only: forget which labels have reported. */
export function __resetRenderStormsForTests(): void {
  lastReported.clear()
}
