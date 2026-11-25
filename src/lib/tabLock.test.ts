import { describe, expect, it, vi } from 'vitest'
import { IncidentTabLock } from './tabLock'
import { FakeLocks, type Cb } from './webLocks.test-utils'

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

  it.each(['AbortError', 'InvalidStateError'])('stops reacquiring after an ungranted %s during navigation', async (name) => {
    let rejectHeld!: (error: Error) => void
    let requests = 0
    const states: boolean[] = []
    const request = vi.fn((_: string, _opts: unknown, cb: Cb) => {
      requests++
      if (requests === 1) {
        void cb({ name: 'inc', mode: 'exclusive' })
        return new Promise((_, reject) => { rejectHeld = reject })
      }
      // Cap the old retry loop so the regression fails without locking the test runner.
      return requests < 5 ? Promise.reject(new DOMException('Document is not fully active', name)) : new Promise(() => {})
    })
    const lock = new IncidentTabLock('inc', (held) => states.push(held), { request } as unknown as Pick<LockManager, 'request'>)
    lock.start()
    rejectHeld(new DOMException('The lock was released', 'AbortError'))
    await tick()
    expect(request).toHaveBeenCalledTimes(2)
    expect(states[states.length - 1]).toBe(false)
    lock.stop()
  })

  it.each(['start', 'takeOver'] as const)('ignores a delayed %s grant after stop', async (action) => {
    let grant!: Cb
    const request = vi.fn((_: string, _opts: unknown, cb: Cb) => {
      grant = cb
      return new Promise(() => {})
    })
    const states: boolean[] = []
    const lock = new IncidentTabLock('inc', (held) => states.push(held), { request } as unknown as Pick<LockManager, 'request'>)
    lock[action]()
    lock.stop()
    let completed = false
    void grant({ name: 'inc', mode: 'exclusive' }).then(() => { completed = true })
    await tick()
    expect(states).toEqual([])
    expect(completed).toBe(true)
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
