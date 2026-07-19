import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Per-incident single-editor tab lock (Web Locks API).
 *
 * Two tabs of the SAME browser editing one incident race the shared IndexedDB sync cache —
 * each holds its own in-memory baseRev, so they 409-thrash and can clobber each other's
 * cache writes. Cross-DEVICE editing is fine (that's what the server merge is for); this is
 * strictly about tabs sharing one origin's storage.
 *
 * Model: the first tab on an incident holds `kp-front-incident-<id>` and edits. A later tab
 * fails the try-acquire, goes read-only (banner in the UI), and queues — when the holder
 * closes, the waiter is promoted to editing automatically. "Hier bearbeiten" steals the lock
 * the other way (the previous holder drops to read-only), so moving editing between tabs is
 * one tap, never a data race.
 *
 * Browsers without Web Locks (none of our supported targets) just keep today's behaviour.
 */

type LocksAPI = Pick<LockManager, 'request'>

function defaultLocks(): LocksAPI | null {
  return typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null
}

export class IncidentTabLock {
  private release: (() => void) | null = null
  private abort: AbortController | null = null
  private stopped = false
  private promoting = false

  constructor(
    private readonly name: string,
    /** fired on every editable/read-only transition of THIS tab */
    private readonly onChange: (held: boolean) => void,
    private readonly locks: LocksAPI | null = defaultLocks(),
  ) {}

  start(): void {
    if (!this.locks) {
      this.onChange(true) // no Web Locks → no coordination, behave as before
      return
    }
    void this.acquire(true)
  }

  /** resolves when stop()/switch releases the held lock */
  private hold(): Promise<void> {
    return new Promise((res) => { this.release = res })
  }

  private async acquire(tryFirst: boolean): Promise<void> {
    if (this.stopped || !this.locks) return
    this.abort = new AbortController()
    try {
      if (tryFirst) {
        let got = false
        await this.locks.request(this.name, { ifAvailable: true }, async (lock) => {
          if (!lock) return // another tab holds it
          got = true
          this.onChange(true)
          await this.hold()
        })
        if (got || this.stopped) return
        this.onChange(false)
      }
      // queue behind the current holder — granted (→ editing) when that tab goes away
      await this.locks.request(this.name, { signal: this.abort.signal }, async () => {
        if (this.stopped) return
        this.onChange(true)
        await this.hold()
      })
    } catch {
      // our hold/queue was stolen or aborted. A deliberate stop()/takeOver() handles its own
      // state; anything else means another tab took editing → drop to read-only and re-queue
      // so we're promoted again if that tab closes.
      if (!this.stopped && !this.promoting) {
        this.onChange(false)
        void this.acquire(false)
      }
    }
  }

  /** Move editing into THIS tab (the current holder drops to read-only). */
  takeOver(): void {
    if (!this.locks || this.stopped) return
    this.promoting = true
    this.abort?.abort() // leave the waiting queue; the steal below replaces it
    void this.locks
      .request(this.name, { steal: true }, async () => {
        this.promoting = false
        this.onChange(true)
        await this.hold()
      })
      .catch(() => {
        this.promoting = false
        if (!this.stopped) {
          this.onChange(false)
          void this.acquire(false) // stolen back by yet another tab → wait in line again
        }
      })
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
    this.release?.()
    this.release = null
  }
}

/** React binding: editable-here state + take-over action for the active incident. */
export function useIncidentTabLock(incidentId: string | null): { held: boolean; takeOver: () => void } {
  // starts true so the common single-tab case never flashes the read-only banner; the
  // try-acquire settles within milliseconds and corrects this if another tab holds the lock.
  const [held, setHeld] = useState(true)
  const ref = useRef<IncidentTabLock | null>(null)
  useEffect(() => {
    if (!incidentId) { setHeld(true); return }
    const lock = new IncidentTabLock(`kp-front-incident-${incidentId}`, setHeld)
    ref.current = lock
    lock.start()
    return () => {
      ref.current = null
      lock.stop()
      setHeld(true)
    }
  }, [incidentId])
  const takeOver = useCallback(() => ref.current?.takeOver(), [])
  return { held, takeOver }
}
