import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ apiBeacon: vi.fn() }))

import { apiBeacon } from './api'
import {
  BUDGET_BURST, BUDGET_REFILL_MS, MAX_PER_SECOND, MAX_SIGNATURES, REPEAT_EVERY_MS,
  __resetClientErrorsForTests, flushClientErrors, reportClientError,
} from './reportError'

// The claim this file pins (24.09.2026): a repeat is COUNTED, never dropped. On 23.09. the iPad's
// second React #185 of the same page load — the Karte crash that mattered — was discarded as a
// duplicate of the first, and the server log said nothing for two hours.

interface Sent { kind: string; message: string; stack?: string; componentStack?: string; surface?: string; repeat?: number; since?: string; last?: string }
const sent = (): Sent[] => vi.mocked(apiBeacon).mock.calls.map((c) => c[1] as Sent)

/** a stable Error: the same message AND the same stack, like a render loop throwing again */
function boom(message = 'Minified React error #185', stack = `Error: ${message}\n    at Xe (index-abc.js:1:2345)`): Error {
  const e = new Error(message)
  e.stack = stack
  return e
}

const T0 = Date.UTC(2026, 8, 23, 18, 39, 43)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  __resetClientErrorsForTests()
})
afterEach(() => {
  __resetClientErrorsForTests()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('reportClientError — first occurrence', () => {
  it('goes out at once and in full', () => {
    reportClientError(boom(), { kind: 'render', componentStack: '\n    at TwinTeamPill\n    at MapView', surface: 'map' })
    expect(apiBeacon).toHaveBeenCalledTimes(1)
    expect(vi.mocked(apiBeacon).mock.calls[0][0]).toBe('/api/diag/client-error')
    const [r] = sent()
    expect(r).toMatchObject({ kind: 'render', message: 'Minified React error #185', surface: 'map' })
    expect(r.stack).toContain('index-abc.js:1:2345')
    expect(r.componentStack).toContain('TwinTeamPill')
    expect(r.repeat).toBeUndefined()
  })

  it('treats the same message from a DIFFERENT component as a new signature', () => {
    // #185 carries react-dom's own stack head whichever component loops — only the component
    // stack tells IncidentWorkspace's loop from TwinTeamPill's
    reportClientError(boom(), { kind: 'render', componentStack: '\n    at IncidentWorkspace' })
    reportClientError(boom(), { kind: 'render', componentStack: '\n    at TwinTeamPill' })
    expect(sent().map((r) => r.componentStack?.trim())).toEqual(['at IncidentWorkspace', 'at TwinTeamPill'])
  })

  it('never throws, even when the transport does', () => {
    vi.mocked(apiBeacon).mockImplementationOnce(() => { throw new Error('no network') })
    expect(() => reportClientError(boom())).not.toThrow()
    expect(() => reportClientError(undefined)).not.toThrow()
  })
})

describe('reportClientError — repeats', () => {
  it('counts them and reports «×N since» once the minute is up', () => {
    reportClientError(boom())
    vi.advanceTimersByTime(1000)
    for (let i = 0; i < 5; i++) { reportClientError(boom()); vi.advanceTimersByTime(1000) }
    expect(apiBeacon).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(REPEAT_EVERY_MS - 6_000 - 1)
    expect(apiBeacon).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(apiBeacon).toHaveBeenCalledTimes(2)
    const r = sent()[1]
    expect(r.repeat).toBe(5)
    expect(r.since).toBe(new Date(T0 + 1000).toISOString())
    expect(r.last).toBe(new Date(T0 + 5000).toISOString())
    // the repeat is lean: the full stack went out with the first one
    expect(r.stack).toBeUndefined()
    expect(r.componentStack).toBeUndefined()
  })

  it('flushes a signature at most once per minute, however hard it throws', () => {
    reportClientError(boom())
    const minutes = 10
    for (let s = 0; s < minutes * 60; s++) {
      for (let k = 0; k < 20; k++) reportClientError(boom())
      vi.advanceTimersByTime(1000)
    }
    // one first report + at most one counter per minute
    expect(vi.mocked(apiBeacon).mock.calls.length).toBeLessThanOrEqual(1 + minutes)
    // …and nothing was lost on the way
    vi.advanceTimersByTime(REPEAT_EVERY_MS)
    const counted = sent().reduce((n, r) => n + (r.repeat ?? 1), 0)
    expect(counted).toBe(1 + minutes * 60 * 20)
  })

  it('makes a crash two hours later in the same page load visible within a minute', () => {
    reportClientError(boom(), { kind: 'render' }) // 18:39 — the #185 that did reach the log
    vi.advanceTimersByTime(2 * 60 * 60_000) // …nothing for two hours…
    reportClientError(boom(), { kind: 'render' }) // 20:28 — the one that did not
    // the minute since the last report is long over, so the counter goes out at once
    expect(apiBeacon).toHaveBeenCalledTimes(2)
    expect(sent()[1]).toMatchObject({ repeat: 1, since: new Date(T0 + 2 * 60 * 60_000).toISOString() })
  })

  it('sends what is still counted when the page goes away', () => {
    reportClientError(boom())
    reportClientError(boom())
    reportClientError(boom())
    expect(apiBeacon).toHaveBeenCalledTimes(1)
    flushClientErrors()
    expect(apiBeacon).toHaveBeenCalledTimes(2)
    expect(sent()[1].repeat).toBe(2)
    // and the timer has nothing left to send
    vi.advanceTimersByTime(REPEAT_EVERY_MS * 2)
    expect(apiBeacon).toHaveBeenCalledTimes(2)
  })
})

describe('reportClientError — load', () => {
  it('10 000 identical errors in a burst cost two requests, and every one is counted', () => {
    for (let i = 0; i < 10_000; i++) reportClientError(boom())
    expect(apiBeacon).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(REPEAT_EVERY_MS)
    expect(apiBeacon).toHaveBeenCalledTimes(2)
    expect(sent()[1].repeat).toBe(9_999)
  })

  it('10 000 DISTINCT errors in a burst stay inside the budget, and every one is counted', () => {
    for (let i = 0; i < 10_000; i++) reportClientError(boom(`error ${i}`, `Error: error ${i}\n    at f${i}`))
    // the same tick: never more than the per-second quota (keepalive requests share 64 kB)
    expect(vi.mocked(apiBeacon).mock.calls.length).toBeLessThanOrEqual(MAX_PER_SECOND)
    vi.advanceTimersByTime(10_000)
    expect(vi.mocked(apiBeacon).mock.calls.length).toBeLessThanOrEqual(BUDGET_BURST)
    // sustained: the bucket refills one request per BUDGET_REFILL_MS, never faster
    const later = 30 * 60_000
    vi.advanceTimersByTime(later)
    expect(vi.mocked(apiBeacon).mock.calls.length).toBeLessThanOrEqual(BUDGET_BURST + Math.ceil((later + 10_000) / BUDGET_REFILL_MS))
    // …and nothing vanished: MAX_SIGNATURES first reports, the rest on the overflow counter
    const firsts = sent().filter((r) => r.repeat === undefined)
    expect(firsts).toHaveLength(MAX_SIGNATURES)
    expect(firsts.every((r) => r.stack)).toBe(true)
    expect(sent().reduce((n, r) => n + (r.repeat ?? 1), 0)).toBe(10_000)
  })
})

describe('reportClientError — kinds', () => {
  it('a surface re-crash is its own signature even with the same error', () => {
    reportClientError(boom(), { kind: 'render', surface: 'map' })
    reportClientError(boom(), { kind: 'surface-recrash', surface: 'map' })
    expect(sent().map((r) => r.kind)).toEqual(['render', 'surface-recrash'])
    expect(sent()[1].stack).toContain('index-abc.js')
  })
})
