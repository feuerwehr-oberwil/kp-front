import { afterEach, describe, expect, it, vi } from 'vitest'
import { frameBatch } from './frameBatch'

afterEach(() => { vi.unstubAllGlobals() })

describe('frameBatch', () => {
  it('runs a step once per frame, at once on flush, and never once cancelled', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let id = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id })
    vi.stubGlobal('cancelAnimationFrame', (n: number) => { frames.delete(n) })
    const step = vi.fn()
    const batch = frameBatch(step)
    batch.schedule(); batch.schedule()
    expect(frames.size).toBe(1)
    frames.forEach((cb) => cb(0)); frames.clear()
    expect(step).toHaveBeenCalledTimes(1)
    batch.schedule()
    batch.flush()
    expect(step).toHaveBeenCalledTimes(2)
    expect(frames.size).toBe(0) // the waiting frame is gone, not run twice
    batch.flush()
    expect(step).toHaveBeenCalledTimes(2) // nothing waits, nothing runs
    batch.schedule(); batch.cancel()
    expect(frames.size).toBe(0) // cancelled: the frame is gone…
    batch.flush()
    expect(step).toHaveBeenCalledTimes(2) // …and a flush finds nothing waiting
  })
})
