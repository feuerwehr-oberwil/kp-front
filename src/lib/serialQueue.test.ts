import { describe, expect, it } from 'vitest'
import { serialQueue } from './serialQueue'

/** A job the test releases by hand, so it can see WHEN the lane started it. */
function gate<T>(value: T) {
  let release!: () => void
  let fail!: (e: Error) => void
  let started = false
  const done = new Promise<T>((res, rej) => {
    release = () => res(value)
    fail = rej
  })
  return { job: () => { started = true; return done }, get started() { return started }, release, fail }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('serialQueue', () => {
  it('starts the next job only after the one before it settled', async () => {
    const run = serialQueue()
    const a = gate('a'), b = gate('b'), c = gate('c')
    const pa = run(a.job), pb = run(b.job), pc = run(c.job)
    await settle()
    expect([a.started, b.started, c.started]).toEqual([true, false, false])
    a.release()
    await settle()
    expect([b.started, c.started]).toEqual([true, false])
    b.release(); c.release()
    expect(await Promise.all([pa, pb, pc])).toEqual(['a', 'b', 'c'])
  })

  it('lets a failed job through to its caller and keeps the lane moving', async () => {
    const run = serialQueue()
    const bad = gate('x'), next = gate('y')
    const pBad = run(bad.job), pNext = run(next.job)
    // the rejection belongs to the failed job's caller only
    bad.fail(new Error('decode failed'))
    await expect(pBad).rejects.toThrow('decode failed')
    await settle()
    expect(next.started).toBe(true)
    next.release()
    expect(await pNext).toBe('y')
  })

  it('serialises a job queued while another is still running', async () => {
    const run = serialQueue()
    const first = gate(1)
    const p1 = run(first.job)
    await settle()
    const late = gate(2)
    const p2 = run(late.job)
    await settle()
    expect(late.started).toBe(false)
    first.release()
    await p1
    await settle()
    expect(late.started).toBe(true)
    late.release()
    expect(await p2).toBe(2)
  })
})
