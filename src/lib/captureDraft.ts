// Save-reliability rails for the capture view (/e/<token>): sessionStorage text drafts
// (a phone lock mid-sentence must not lose the Kurzbericht), a debounced flusher that
// chains overlapping saves per field/line, and the clock-skew readout for the backend's
// X-Server-Time header. Pure logic — the CaptureApp wires it to inputs and saveAction.

/** Storage-shaped for tests; sessionStorage in the app (same spirit as RECORDER_KEY). */
export interface DraftStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const draftKey = (incidentId: string, field: string) => `kp.capture.draft.${incidentId}.${field}`

export function saveDraft(store: DraftStore, incidentId: string, field: string, value: string): void {
  try { store.setItem(draftKey(incidentId, field), JSON.stringify({ v: value, at: Date.now() })) } catch { /* quota/private mode — drafts are best-effort */ }
}

export function loadDraft(store: DraftStore, incidentId: string, field: string): string | null {
  try {
    const raw = store.getItem(draftKey(incidentId, field))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { v?: unknown }
    return typeof parsed?.v === 'string' ? parsed.v : null
  } catch { return null }
}

export function clearDraft(store: DraftStore, incidentId: string, field: string): void {
  try { store.removeItem(draftKey(incidentId, field)) } catch { /* best-effort */ }
}

/** Drafts clear on successful save, so a surviving draft that differs from the saved
 *  value is by definition newer/unsaved — it wins. Identical or absent → saved value. */
export function restoreDraft(store: DraftStore, incidentId: string, field: string, saved: string): string {
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
