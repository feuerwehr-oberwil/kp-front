/*
 * A Web Lock request rejected before a grant must not immediately requeue: an inactive
 * document can reject forever and prevent navigation. Requeue only after a held lock is lost,
 * and ignore grants that arrive after the owner stopped.
 */

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
 * one tap. The lock only orders the tabs; who may WRITE follows it in lib/incidentSelection (a
 * follower engine writes nothing, a grant opens a fresh editor that fences the cache slot, a
 * stolen holder retires at once).
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
  private generation = 0

  constructor(
    private readonly name: string,
    /** fired on every editable/read-only transition of THIS tab */
    private readonly onChange: (held: boolean) => void,
    private readonly locks: LocksAPI | null = defaultLocks(),
  ) {}

  start(): void {
    if (this.stopped) return
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
    const generation = ++this.generation
    const current = () => !this.stopped && generation === this.generation
    let granted = false
    this.abort = new AbortController()
    try {
      if (tryFirst) {
        let got = false
        await this.locks.request(this.name, { ifAvailable: true }, async (lock) => {
          if (!lock || !current()) return // another tab holds it, or this request ended
          got = true
          granted = true
          this.onChange(true)
          await this.hold()
        })
        if (got || !current()) return
        this.onChange(false)
      }
      // queue behind the current holder — granted (→ editing) when that tab goes away
      await this.locks.request(this.name, { signal: this.abort.signal }, async () => {
        if (!current()) return
        granted = true
        this.onChange(true)
        await this.hold()
      })
    } catch {
      if (!current()) return
      this.onChange(false)
      // A stolen holder may queue again. An ungranted rejection must stop: WebKit rejects
      // requests from a departing document, and immediate retries freeze navigation.
      if (granted) void this.acquire(false)
    }
  }

  /** Move editing into THIS tab (the current holder drops to read-only). */
  takeOver(): void {
    if (!this.locks || this.stopped) return
    const generation = ++this.generation
    const current = () => !this.stopped && generation === this.generation
    let granted = false
    this.abort?.abort() // leave the waiting queue; the steal below replaces it
    void this.locks
      .request(this.name, { steal: true }, async () => {
        if (!current()) return
        granted = true
        this.onChange(true)
        await this.hold()
      })
      .catch(() => {
        if (!current()) return
        this.onChange(false)
        if (granted) void this.acquire(false) // stolen back → wait in line again
      })
  }

  stop(): void {
    this.stopped = true
    this.generation++
    this.abort?.abort()
    this.release?.()
    this.release = null
  }
}
