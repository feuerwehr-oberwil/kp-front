import type { SyncStatus } from './incidents'

// Episode detection for the sync-trouble toasts: the engine reports a status on every save /
// poll, so a broken connection would re-fire on each failed attempt. This tracker turns that
// stream into ONE notification per trouble episode — `error` announces immediately on the
// transition into 'error'; `offline` announces only once the state has PERSISTED for
// `offlineDelayMs` (a brief tunnel blip resolves silently). A successful sync ('synced') ends
// the episode and re-arms both. 'pending' is the normal save-in-flight state and is ignored —
// the offline→pending→offline flap of a retrying save must not restart the persistence clock.
// Pure timer wiring; the caller renders the toast (deliberately NO persistent banner).

export type SyncAlertKind = 'error' | 'offline'

export interface SyncAlertTracker {
  onStatus: (s: SyncStatus) => void
  dispose: () => void
}

export const OFFLINE_ALERT_DELAY_MS = 30_000

/** Warn threshold for device-vs-server clock skew, in whole minutes — the same bound the
 *  capture surface uses (CaptureApp: warn when |serverSkewMinutes| > 3). */
export const CLOCK_SKEW_WARN_MIN = 3

/**
 * Episode detection for the clock-skew toast, same doctrine as the sync-trouble tracker above:
 * the live-follow poll samples the server clock every round, so a skewed device would re-warn
 * forever. One notification per episode — announced on crossing the threshold, re-armed only
 * once a sample comes back within it (the operator fixed the clock / NTP caught up). A null
 * sample (unparseable header) carries no information and changes nothing.
 */
export function createClockSkewAlert(
  notify: (skewMin: number) => void,
): { onSkew: (skewMin: number | null) => void } {
  let announced = false
  return {
    onSkew(skewMin: number | null) {
      if (skewMin === null) return
      const mag = Math.abs(skewMin)
      if (mag > CLOCK_SKEW_WARN_MIN) {
        if (!announced) { announced = true; notify(skewMin) }
      } else if (mag <= CLOCK_SKEW_WARN_MIN - 1) {
        // Re-arm only a full minute INSIDE the bound. A clock straddling the threshold flips
        // 3↔4 on network jitter; re-arming at exactly the bound re-fired the toast every flip.
        announced = false
      }
    },
  }
}

export function createSyncAlertTracker(
  notify: (kind: SyncAlertKind) => void,
  opts?: { offlineDelayMs?: number },
): SyncAlertTracker {
  const offlineDelayMs = opts?.offlineDelayMs ?? OFFLINE_ALERT_DELAY_MS
  let errorAnnounced = false
  let offlineAnnounced = false
  let offlineTimer: ReturnType<typeof setTimeout> | null = null
  const clearOfflineTimer = () => {
    if (offlineTimer != null) { clearTimeout(offlineTimer); offlineTimer = null }
  }
  return {
    onStatus(s: SyncStatus) {
      if (s === 'synced') {
        // episode over — re-arm both alerts for the next one
        clearOfflineTimer()
        errorAnnounced = false
        offlineAnnounced = false
        return
      }
      if (s === 'error') {
        clearOfflineTimer() // the louder signal supersedes a pending offline announcement
        if (!errorAnnounced) { errorAnnounced = true; notify('error') }
        return
      }
      if (s === 'offline' && !offlineAnnounced && offlineTimer == null) {
        offlineTimer = setTimeout(() => {
          offlineTimer = null
          offlineAnnounced = true
          notify('offline')
        }, offlineDelayMs)
      }
      // 'pending' → ignore (see header comment)
    },
    dispose: clearOfflineTimer,
  }
}
