import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOCK_SKEW_WARN_MIN, createClockSkewAlert, createSyncAlertTracker } from './syncAlert'

describe('createSyncAlertTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('announces error once on the transition into error, not on every failed attempt', () => {
    const notify = vi.fn()
    const t = createSyncAlertTracker(notify)
    t.onStatus('pending')
    t.onStatus('error')
    t.onStatus('error')
    t.onStatus('pending')
    t.onStatus('error')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('error')
  })

  it('re-arms the error alert after a successful sync ends the episode', () => {
    const notify = vi.fn()
    const t = createSyncAlertTracker(notify)
    t.onStatus('error')
    t.onStatus('synced')
    t.onStatus('error')
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('announces offline only once it has persisted for the delay', () => {
    const notify = vi.fn()
    const t = createSyncAlertTracker(notify, { offlineDelayMs: 30_000 })
    t.onStatus('offline')
    vi.advanceTimersByTime(29_000)
    expect(notify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('offline')
  })

  it('stays silent on a brief offline blip that recovers before the delay', () => {
    const notify = vi.fn()
    const t = createSyncAlertTracker(notify, { offlineDelayMs: 30_000 })
    t.onStatus('offline')
    vi.advanceTimersByTime(5_000)
    t.onStatus('synced')
    vi.advanceTimersByTime(60_000)
    expect(notify).not.toHaveBeenCalled()
  })

  it('a retrying save (offline→pending→offline flap) does not restart the persistence clock', () => {
    const notify = vi.fn()
    const t = createSyncAlertTracker(notify, { offlineDelayMs: 30_000 })
    t.onStatus('offline')
    vi.advanceTimersByTime(20_000)
    t.onStatus('pending')
    t.onStatus('offline')
    vi.advanceTimersByTime(10_000)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('offline')
  })

  it('announces offline at most once per episode', () => {
    const notify = vi.fn()
    const t = createSyncAlertTracker(notify, { offlineDelayMs: 1_000 })
    t.onStatus('offline')
    vi.advanceTimersByTime(1_000)
    t.onStatus('offline') // still offline — must not schedule again
    vi.advanceTimersByTime(60_000)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('an error supersedes a pending offline announcement', () => {
    const notify = vi.fn()
    const t = createSyncAlertTracker(notify, { offlineDelayMs: 30_000 })
    t.onStatus('offline')
    t.onStatus('error')
    vi.advanceTimersByTime(60_000)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('error')
  })

  it('dispose cancels a scheduled offline announcement', () => {
    const notify = vi.fn()
    const t = createSyncAlertTracker(notify, { offlineDelayMs: 1_000 })
    t.onStatus('offline')
    t.dispose()
    vi.advanceTimersByTime(60_000)
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('createClockSkewAlert', () => {
  it('announces once per episode, not on every sample of a still-skewed clock', () => {
    const notify = vi.fn()
    const a = createClockSkewAlert(notify)
    a.onSkew(10)
    a.onSkew(10)
    a.onSkew(11)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(10)
  })

  it('re-arms once a sample comes back within the threshold (clock fixed → new episode)', () => {
    const notify = vi.fn()
    const a = createClockSkewAlert(notify)
    a.onSkew(-8) // behind counts like ahead
    a.onSkew(0)
    a.onSkew(8)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('a boundary flap does not re-fire: the band at the threshold neither fires nor re-arms', () => {
    const notify = vi.fn()
    const a = createClockSkewAlert(notify)
    a.onSkew(CLOCK_SKEW_WARN_MIN + 1) // 4 → fires
    a.onSkew(CLOCK_SKEW_WARN_MIN)     // 3 → in the hysteresis band: stays announced
    a.onSkew(CLOCK_SKEW_WARN_MIN + 1) // 4 again → still the same episode
    expect(notify).toHaveBeenCalledTimes(1)
    a.onSkew(CLOCK_SKEW_WARN_MIN - 1) // 2 → a full minute inside: re-arms
    a.onSkew(CLOCK_SKEW_WARN_MIN + 1) // 4 → new episode
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('stays silent within the threshold and ignores unparseable (null) samples', () => {
    const notify = vi.fn()
    const a = createClockSkewAlert(notify)
    a.onSkew(CLOCK_SKEW_WARN_MIN) // exactly at the bound — not over it
    a.onSkew(null)
    expect(notify).not.toHaveBeenCalled()
    a.onSkew(CLOCK_SKEW_WARN_MIN + 1)
    a.onSkew(null) // no information — must not end the episode either
    a.onSkew(CLOCK_SKEW_WARN_MIN + 1)
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
