// The live-follow long poll as a hook: `createLongPollLoop` (lib/pollBackoff) on the app's cadence
// (`appConfig.sync`), its first round `livePollMs` after the effect runs, and stopped on teardown,
// so a held ~20 s request never outlives the component that issued it. The workspace sync
// (useIncidentSync) and the Verlauf (useJournal) both follow on it; the round is all that differs.
// The mechanics — visibility, ease-off, abort, the next round right after an answer — are the
// loop's and are documented there.

import { useCallback, useEffect, useRef, type DependencyList } from 'react'
import { appConfig } from '../config/appConfig'
import { createLongPollLoop, SLOW_FOLLOW_MS, type LongPollLoop, type LongPollLoopOpts } from './pollBackoff'

export interface UseLongPollOpts extends Pick<LongPollLoopOpts, 'round' | 'onSuspend' | 'onOnline'> {
  /** Delay while the tab is hidden. Defaults to `appConfig.sync.hiddenPollMs`. */
  hiddenMs?: () => number
  /** Follow once a minute instead (SLOW_FOLLOW_MS — the Atemschutz-Link of a CLOSED Einsatz,
   *  refused until a reopen; pollBackoff · minDelayMs). Read per round: a flip never restarts. */
  slowFollow?: boolean
}

/**
 * Runs the loop while the component is mounted and returns `restart(delay)` — stable, and a no-op
 * when no loop runs; `restart(0)` catches up now («Jetzt synchronisieren»).
 *
 * `deps` work like an effect's: a change stops the loop and starts a new one with THAT render's
 * callbacks (the round, hiddenMs, …), which are otherwise never re-read. So whatever the round
 * reads that may change goes either into `deps` or behind a ref.
 */
export function useLongPoll(
  { round, hiddenMs = () => appConfig.sync.hiddenPollMs, onSuspend, onOnline, slowFollow = false }: UseLongPollOpts,
  deps: DependencyList,
): LongPollLoop['start'] {
  const slowFollowRef = useRef(slowFollow)
  useEffect(() => { slowFollowRef.current = slowFollow }, [slowFollow])
  const startRef = useRef<LongPollLoop['start'] | null>(null)

  useEffect(() => {
    const loop = createLongPollLoop({
      baseMs: appConfig.sync.livePollMs,
      maxMs: appConfig.sync.livePollMaxMs,
      hiddenMs,
      minDelayMs: () => (slowFollowRef.current ? SLOW_FOLLOW_MS : 0),
      round,
      onSuspend,
      onOnline,
    })
    loop.start(appConfig.sync.livePollMs)
    startRef.current = loop.start
    return () => {
      loop.stop()
      startRef.current = null
    }
    // the caller's deps decide when the loop restarts (see above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return useCallback((delay: number) => startRef.current?.(delay), [])
}
