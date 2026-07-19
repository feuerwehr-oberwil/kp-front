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
