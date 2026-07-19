import { useEffect } from 'react'

// Minimal typing for the Screen Wake Lock API — TS lib.dom may lack it depending
// on target, and we want to compile without DOM-lib churn.
interface WakeLockSentinelLike {
  released: boolean
  release: () => Promise<void>
}
interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>
}

/**
 * Keep the screen awake while `active` is true (e.g. during a live incident on a
 * station/vehicle tablet, so the map never dims or sleeps mid-operation).
 *
 * Behaviour:
 *  - Requests `navigator.wakeLock.request('screen')` when active.
 *  - The OS silently drops the lock whenever the tab is hidden/backgrounded, so we
 *    re-acquire on `visibilitychange` when the page becomes visible again.
 *  - Releases on unmount or when `active` flips to false.
 *  - No-ops (and never throws) on browsers without the API — it's a progressive
 *    enhancement, not a hard dependency.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock
    if (!wakeLock) return // API unavailable (older browsers, insecure context)

    let sentinel: WakeLockSentinelLike | null = null
    let cancelled = false

    const acquire = async () => {
      // Only meaningful while the page is visible — a hidden tab can't hold the lock.
      if (document.visibilityState !== 'visible') return
      try {
        const s = await wakeLock.request('screen')
        if (cancelled) {
          // effect tore down mid-request — release immediately
          void s.release().catch(() => {})
          return
        }
        sentinel = s
      } catch {
        // request can reject (e.g. low battery, denied) — fail quiet, try again next visibility
      }
    }

    const onVisibility = () => {
      // the lock auto-drops when hidden; re-acquire once we're foreground again
      if (document.visibilityState === 'visible' && (!sentinel || sentinel.released)) {
        void acquire()
      }
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {})
      sentinel = null
    }
  }, [active])
}
