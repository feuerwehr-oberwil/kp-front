// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { visibleInterval } from './visibleInterval'

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => { vi.useFakeTimers(); setHidden(false) })
afterEach(() => { vi.useRealTimers() })

describe('visibleInterval', () => {
  it('runs at once and then on the cadence while visible', () => {
    const round = vi.fn()
    const stop = visibleInterval(round, 15_000)
    expect(round).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_000)
    expect(round).toHaveBeenCalledTimes(3)
    stop()
  })

  it('sleeps while hidden and runs at once on the way back', () => {
    const round = vi.fn()
    const stop = visibleInterval(round, 15_000)
    setHidden(true)
    vi.advanceTimersByTime(10 * 60_000)
    expect(round).toHaveBeenCalledTimes(1) // not one request for a screen nobody sees
    setHidden(false)
    expect(round).toHaveBeenCalledTimes(2) // fresh the moment somebody looks again
    vi.advanceTimersByTime(15_000)
    expect(round).toHaveBeenCalledTimes(3) // …and back on the cadence
    stop()
  })

  it('a repeated «visible» is not a return', () => {
    const round = vi.fn()
    const stop = visibleInterval(round, 15_000)
    setHidden(false)
    setHidden(false)
    expect(round).toHaveBeenCalledTimes(1)
    stop()
  })

  it('started on a hidden page, it waits for the page to be seen', () => {
    setHidden(true)
    const round = vi.fn()
    const stop = visibleInterval(round, 15_000)
    vi.advanceTimersByTime(60_000)
    expect(round).not.toHaveBeenCalled()
    setHidden(false)
    expect(round).toHaveBeenCalledTimes(1)
    stop()
  })

  it('`leading: false` keeps the cadence but skips the at-once rounds', () => {
    const round = vi.fn()
    const stop = visibleInterval(round, 15_000, { leading: false })
    expect(round).not.toHaveBeenCalled()
    vi.advanceTimersByTime(15_000)
    expect(round).toHaveBeenCalledTimes(1)
    setHidden(true)
    setHidden(false)
    expect(round).toHaveBeenCalledTimes(1) // the feed's return round gets a cadence to land
    vi.advanceTimersByTime(15_000)
    expect(round).toHaveBeenCalledTimes(2)
    stop()
  })

  it('stop ends it for good, visibility changes included', () => {
    const round = vi.fn()
    visibleInterval(round, 15_000)()
    setHidden(true)
    setHidden(false)
    vi.advanceTimersByTime(60_000)
    expect(round).toHaveBeenCalledTimes(1)
  })
})
