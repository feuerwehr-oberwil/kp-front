// Test double for the Web Locks API (navigator.locks), shared by the tab-lock and the tab-handover
// tests. One instance stands for one browser: every «tab» built in a test uses the same one.

// A faithful in-memory LockManager: exclusive named locks with ifAvailable / queue /
// steal / AbortSignal semantics per the Web Locks spec (the parts IncidentTabLock uses).
export type Cb = (lock: { name: string; mode: string } | null) => Promise<unknown>
interface Waiter { cb: Cb; resolve: (v: unknown) => void; reject: (e: Error) => void; signal?: AbortSignal }

export class FakeLocks {
  private held = new Map<string, { reject: (e: Error) => void; done: Promise<void> }>()
  private queue = new Map<string, Waiter[]>()

  request(name: string, optsOrCb: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal } | Cb, maybeCb?: Cb): Promise<unknown> {
    const opts = typeof optsOrCb === 'function' ? {} : optsOrCb
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb as Cb
    return new Promise((resolve, reject) => {
      const grant = () => {
        let rejectHold!: (e: Error) => void
        const stolen = new Promise<never>((_, r) => { rejectHold = r })
        const run = cb({ name, mode: 'exclusive' })
        const done = Promise.race([run, stolen]).then(
          (v) => { this.release(name, done); resolve(v) },
          (e) => { this.release(name, done); reject(e) },
        ) as Promise<void>
        this.held.set(name, { reject: rejectHold, done })
      }
      if (opts.steal) {
        const cur = this.held.get(name)
        if (cur) { this.held.delete(name); cur.reject(new DOMException('stolen', 'AbortError')) }
        grant()
        return
      }
      if (!this.held.has(name)) { grant(); return }
      if (opts.ifAvailable) {
        void cb(null).then(resolve, reject)
        return
      }
      const w: Waiter = { cb, resolve, reject, signal: opts.signal }
      opts.signal?.addEventListener('abort', () => {
        const q = this.queue.get(name) ?? []
        const i = q.indexOf(w)
        if (i >= 0) { q.splice(i, 1); reject(new DOMException('aborted', 'AbortError')) }
      })
      this.queue.set(name, [...(this.queue.get(name) ?? []), w])
    })
  }

  private release(name: string, done: Promise<void>) {
    // A stolen holder settling cannot release the replacement holder.
    if (this.held.get(name)?.done !== done) return
    this.held.delete(name)
    const q = this.queue.get(name) ?? []
    const next = q.shift()
    if (!next) return
    let rejectHold!: (e: Error) => void
    const stolen = new Promise<never>((_, r) => { rejectHold = r })
    const nextDone = Promise.race([next.cb({ name, mode: 'exclusive' }), stolen]).then(
      (v) => { this.release(name, nextDone); next.resolve(v) },
      (e) => { this.release(name, nextDone); next.reject(e) },
    ) as Promise<void>
    this.held.set(name, { reject: rejectHold, done: nextDone })
  }
}

