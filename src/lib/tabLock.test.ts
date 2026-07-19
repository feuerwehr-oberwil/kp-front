import { describe, expect, it } from 'vitest'
import { IncidentTabLock } from './tabLock'

// A faithful in-memory LockManager: exclusive named locks with ifAvailable / queue /
// steal / AbortSignal semantics per the Web Locks spec (the parts IncidentTabLock uses).
type Cb = (lock: { name: string; mode: string } | null) => Promise<unknown>
interface Waiter { cb: Cb; resolve: (v: unknown) => void; reject: (e: Error) => void; signal?: AbortSignal }

class FakeLocks {
  private held = new Map<string, { reject: (e: Error) => void; done: Promise<void> }>()
  private queue = new Map<string, Waiter[]>()

  request(name: string, opts: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }, cb: Cb): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        let rejectHold!: (e: Error) => void
        const stolen = new Promise<never>((_, r) => { rejectHold = r })
        const run = cb({ name, mode: 'exclusive' })
        const done = Promise.race([run, stolen]).then(
          (v) => { this.release(name); resolve(v) },
          (e) => { this.release(name); reject(e) },
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

  private release(name: string) {
    this.held.delete(name)
    const q = this.queue.get(name) ?? []
    const next = q.shift()
    if (!next) return
    let rejectHold!: (e: Error) => void
    const stolen = new Promise<never>((_, r) => { rejectHold = r })
    const done = Promise.race([next.cb({ name, mode: 'exclusive' }), stolen]).then(
      (v) => { this.release(name); next.resolve(v) },
      (e) => { this.release(name); next.reject(e) },
    ) as Promise<void>
    this.held.set(name, { reject: rejectHold, done })
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function tab(locks: FakeLocks, name = 'inc') {
  const states: boolean[] = []
  const lock = new IncidentTabLock(name, (h) => states.push(h), locks as unknown as Pick<LockManager, 'request'>)
  return { lock, states, get held() { return states[states.length - 1] } }
}

describe('IncidentTabLock', () => {
  it('single tab acquires and edits', async () => {
    const locks = new FakeLocks()
    const a = tab(locks)
    a.lock.start()
    await tick()
    expect(a.held).toBe(true)
    a.lock.stop()
  })

  it('second tab goes read-only, promoted automatically when the holder closes', async () => {
    const locks = new FakeLocks()
    const a = tab(locks)
    const b = tab(locks)
    a.lock.start()
    await tick()
    b.lock.start()
    await tick()
    expect(a.held).toBe(true)
    expect(b.held).toBe(false)

    a.lock.stop() // first tab closes → waiter is promoted
    await tick()
    expect(b.held).toBe(true)
    b.lock.stop()
  })

  it('takeOver steals editing into this tab; the previous holder drops to read-only', async () => {
    const locks = new FakeLocks()
    const a = tab(locks)
    const b = tab(locks)
    a.lock.start()
    await tick()
    b.lock.start()
    await tick()

    b.lock.takeOver()
    await tick()
    expect(b.held).toBe(true)
    expect(a.held).toBe(false)

    // …and the stolen-from tab re-queued: closing B promotes A back to editing.
    b.lock.stop()
    await tick()
    expect(a.held).toBe(true)
    a.lock.stop()
  })

  it('without Web Locks (no API) the tab just stays editable', async () => {
    const states: boolean[] = []
    const lock = new IncidentTabLock('inc', (h) => states.push(h), null)
    lock.start()
    await tick()
    expect(states).toEqual([true])
    lock.stop()
  })

  it('stop() while queued leaves the holder untouched', async () => {
    const locks = new FakeLocks()
    const a = tab(locks)
    const b = tab(locks)
    a.lock.start()
    await tick()
    b.lock.start()
    await tick()
    b.lock.stop() // second tab closes while waiting
    await tick()
    expect(a.held).toBe(true)
    a.lock.stop()
  })
})
