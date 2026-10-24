// Save-reliability rails for the capture view (/e/<token>): sessionStorage text drafts
// (a phone lock mid-sentence must not lose the Kurzbericht), a debounced flusher that
// chains overlapping saves per field/line, and the clock-skew readout for the backend's
// X-Server-Time header. Pure logic — the CaptureApp wires it to inputs and saveAction.
//
// A draft is one lib/incidentPrefStore value per incident AND field (best-effort; the storage is
// passed in — sessionStorage in the app, a map in tests). ⚠️ Key and stored shape are what a
// phone holds mid-Einsatz: `kp.capture.draft.<incident>.<field>` → `{"v": text, "at": ms}`.

import { incidentPrefStore, type PrefStorage } from './incidentPrefStore'

/** A stored draft: the text, and when it was typed (`at` is written, never read). */
interface StoredDraft { v: string; at?: number }

const drafts = (store: PrefStorage, field: string) => incidentPrefStore<StoredDraft>({
  key: (incidentId) => `kp.capture.draft.${incidentId}.${field}`,
  parse: (d) => (typeof d === 'object' && d !== null && 'v' in d && typeof d.v === 'string' ? { v: d.v } : undefined),
  storage: () => store,
})

export function saveDraft(store: PrefStorage, incidentId: string, field: string, value: string): void {
  drafts(store, field).write(incidentId, { v: value, at: Date.now() })
}

export function loadDraft(store: PrefStorage, incidentId: string, field: string): string | null {
  return drafts(store, field).read(incidentId)?.v ?? null
}

export function clearDraft(store: PrefStorage, incidentId: string, field: string): void {
  drafts(store, field).clear(incidentId)
}

/** Drafts clear on successful save, so a surviving draft that differs from the saved
 *  value is by definition newer/unsaved — it wins. Identical or absent → saved value. */
export function restoreDraft(store: PrefStorage, incidentId: string, field: string, saved: string): string {
  const draft = loadDraft(store, incidentId, field)
  return draft !== null && draft !== saved ? draft : saved
}

export interface DebouncedFlush<T> {
  /** remember the latest value and (re)start the debounce timer */
  push: (v: T) => void
  /** flush a pending value immediately (blur/unmount); no-op when clean */
  flushNow: () => Promise<void>
  /** drop the pending value and timer without flushing */
  cancel: () => void
}

/**
 * Debounce-with-chaining: `push` keeps only the LATEST value and flushes it `delayMs`
 * after the last push. A value pushed while a flush is in flight is flushed right after
 * it settles (never dropped, never concurrent per instance). Flush errors are the
 * callback's to surface — a rejection here is swallowed so a timer can't go unhandled.
 */
export function makeDebouncedFlush<T>(delayMs: number, flush: (v: T) => Promise<unknown>): DebouncedFlush<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: { v: T } | null = null
  let inFlight = false
  const fire = async () => {
    if (inFlight) return // the in-flight loop below picks `latest` up after its await
    inFlight = true
    while (latest) {
      const { v } = latest
      latest = null
      try { await flush(v) } catch { /* the flush callback owns error handling */ }
    }
    inFlight = false
  }
  return {
    push(v) {
      latest = { v }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void fire() }, delayMs)
    },
    async flushNow() {
      if (timer) { clearTimeout(timer); timer = null }
      await fire()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      latest = null
    },
  }
}

/** Device-minus-server clock skew in whole minutes (positive = device runs ahead),
 *  or null when the header value isn't a parseable timestamp. */
export function serverSkewMinutes(headerIso: string, deviceNowMs: number): number | null {
  const server = Date.parse(headerIso)
  if (!Number.isFinite(server)) return null
  return Math.round((deviceNowMs - server) / 60000)
}
