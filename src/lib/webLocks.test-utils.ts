// Test double for the Web Locks API (navigator.locks), shared by the tab-lock and the tab-handover
// tests. One instance stands for one browser; `client(id)` is one document (tab) of it, with the
// `clientId` its locks show in `query()`. Requests made on the instance itself come from 'default'.

// A faithful in-memory LockManager: exclusive named locks with ifAvailable / queue /
// steal / AbortSignal semantics per the Web Locks spec (the parts IncidentTabLock uses).
export type Cb = (lock: { name: string; mode: string } | null) => Promise<unknown>
type Opts = { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }
interface Waiter { client: string; cb: Cb; resolve: (v: unknown) => void; reject: (e: Error) => void }
interface Held { client: string; reject: (e: Error) => void; done: Promise<void> }

export class FakeLocks {
  private held = new Map<string, Held>()
  private queue = new Map<string, Waiter[]>()
  /** the browser releases a lock this long after its request settled (0: at once) – the spec
   *  queues the release as its own task, so a settled request can still hold the lock */
  releaseLagMs = 0
  /** a failed try hears its `null` this long after the browser decided it (0: at once) */
  nullLagMs = 0

  /** One document of this browser. */
  client(id: string): Pick<LockManager, 'request' | 'query'> {
    return {
      request: ((name: string, optsOrCb: Opts | Cb, maybeCb?: Cb) => this.requestAs(id, name, optsOrCb, maybeCb)) as LockManager['request'],
      query: () => this.query(),
    }
  }

  request(name: string, optsOrCb: Opts | Cb, maybeCb?: Cb): Promise<unknown> {
    return this.requestAs('default', name, optsOrCb, maybeCb)
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: [...this.held].map(([name, h]) => ({ name, mode: 'exclusive', clientId: h.client })),
      pending: [...this.queue].flatMap(([name, q]) => q.map((w) => ({ name, mode: 'exclusive' as const, clientId: w.client }))),
    }
  }

  private requestAs(client: string, name: string, optsOrCb: Opts | Cb, maybeCb?: Cb): Promise<unknown> {
    const opts = typeof optsOrCb === 'function' ? {} : optsOrCb
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb as Cb
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { client, cb, resolve, reject }
      if (opts.steal) {
        const cur = this.held.get(name)
        if (cur) { this.held.delete(name); cur.reject(new DOMException('stolen', 'AbortError')) }
        this.grant(name, waiter)
        return
      }
      if (!this.held.has(name)) { this.grant(name, waiter); return }
      if (opts.ifAvailable) {
        const answer = () => { void cb(null).then(resolve, reject) }
        if (this.nullLagMs) setTimeout(answer, this.nullLagMs)
        else answer()
        return
      }
      opts.signal?.addEventListener('abort', () => {
        const q = this.queue.get(name) ?? []
        const i = q.indexOf(waiter)
        if (i >= 0) { q.splice(i, 1); reject(new DOMException('aborted', 'AbortError')) }
      })
      this.queue.set(name, [...(this.queue.get(name) ?? []), waiter])
    })
  }

  /** What WebKit does to a lone document it suspends (back-forward cache, an iOS app in the
   *  background): the held request rejects and the lock is free – no other tab took it. */
  suspend(name: string): void {
    this.held.get(name)?.reject(new DOMException('released by the browser', 'AbortError'))
  }

  private grant(name: string, w: Waiter) {
    let rejectHold!: (e: Error) => void
    const stolen = new Promise<never>((_, r) => { rejectHold = r })
    // held BEFORE the callback runs, as in a browser: a query() inside it sees the lock
    const held: Held = { client: w.client, reject: rejectHold, done: Promise.resolve() }
    this.held.set(name, held)
    const settle = (finish: () => void) => {
      finish()
      if (this.releaseLagMs) setTimeout(() => this.release(name, held), this.releaseLagMs)
      else this.release(name, held)
    }
    held.done = Promise.race([w.cb({ name, mode: 'exclusive' }), stolen]).then(
      (v) => settle(() => w.resolve(v)),
      (e) => settle(() => w.reject(e)),
    )
  }

  private release(name: string, held: Held) {
    // A stolen holder settling cannot release the replacement holder.
    if (this.held.get(name) !== held) return
    this.held.delete(name)
    const next = (this.queue.get(name) ?? []).shift()
    if (next) this.grant(name, next)
  }
}
