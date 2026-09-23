import { afterEach, describe, expect, it, vi } from 'vitest'
import { whenIdle } from './idle'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('whenIdle', () => {
  it('hands the task to requestIdleCallback with the timeout, and cancels through it', () => {
    const ric = vi.fn().mockReturnValue(7)
    const cic = vi.fn()
    vi.stubGlobal('window', { requestIdleCallback: ric, cancelIdleCallback: cic })
    const task = vi.fn()
    const cancel = whenIdle(task, 1500)
    expect(ric).toHaveBeenCalledWith(task, { timeout: 1500 })
    cancel()
    expect(cic).toHaveBeenCalledWith(7)
  })

  it('falls back to a short timer where the browser has no idle callback (WebKit)', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {})
    const task = vi.fn()
    whenIdle(task, 5000)
    vi.advanceTimersByTime(599)
    expect(task).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('a cancelled fallback never runs', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {})
    const task = vi.fn()
    whenIdle(task)()
    vi.advanceTimersByTime(10_000)
    expect(task).not.toHaveBeenCalled()
  })
})
