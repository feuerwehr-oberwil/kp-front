import { useCallback, useEffect, useRef } from 'react'

/** Cadence of the always-on watches. Slow on purpose: they backstop a push that already
 *  happened (alarm auto-open, a colleague's take), they don't carry it. */
export const WATCH_POLL_MS = 30_000
/** A tablet gets picked up and put down constantly; without a floor, every foreground fired a
 *  full round-trip. A resume within this window is skipped — the interval keeps things fresh. */
export const WATCH_RESUME_GAP_MS = 10_000

export interface ResumingPollOpts {
  pollMs: number
  /** minimum quiet time before a foreground return is worth a round of its own */
  resumeGapMs: number
}

/**
 * An always-on watch: run `refresh` on a cadence while `enabled`, plus once whenever the tab
 * comes back to the foreground and the last round is older than `resumeGapMs`.
 *
 * The runner is guarded — one round at a time (a round can take the full request bound; a tick
 * that ignored that would stack requests) — and swallows failures, because both watches must
 * keep their last-known state on a transient error rather than blank what is on screen.
 *
 * Returns that guarded runner, so a caller can also fire it by hand (useDiveraWatch hands it to
 * the UI for the refresh after a take) and have the manual round share the busy/last-at guards.
 */
export function useResumingPoll(
  enabled: boolean,
  refresh: () => Promise<void>,
  { pollMs, resumeGapMs }: ResumingPollOpts,
): () => Promise<void> {
  const busy = useRef(false)
  const lastAt = useRef(0)

  const run = useCallback(async () => {
    if (!enabled || busy.current) return
    busy.current = true
    try {
      await refresh()
    } catch {
      /* transient failure — keep the last-known state */
    } finally {
      lastAt.current = Date.now()
      busy.current = false
    }
  }, [enabled, refresh])

  useEffect(() => {
    if (!enabled) return
    void run()
    const t = setInterval(() => void run(), pollMs)
    const onVis = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAt.current >= resumeGapMs) void run()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [enabled, run, pollMs, resumeGapMs])

  return run
}
