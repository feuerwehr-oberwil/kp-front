import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import {
  foldTrouble, pickTrouble, markAsked, readTrouble, recordTrouble, markTroubleAsked,
  COOLDOWN_MS, STALE_MS, DEDUPE_MS, MAX_EVENTS, EMPTY_LOG, type TroubleLog,
} from './trouble'

const T0 = 1_800_000_000_000 // fixed epoch; Date.now() is never used in the pure tests

describe('foldTrouble', () => {
  it('appends the first event', () => {
    const log = foldTrouble(EMPTY_LOG, 'crash', T0)
    expect(log.events).toEqual([{ kind: 'crash', at: T0 }])
  })

  it('collapses a repeat of the same kind inside the dedupe window', () => {
    let log = foldTrouble(EMPTY_LOG, 'crash', T0)
    log = foldTrouble(log, 'crash', T0 + DEDUPE_MS - 1)
    // one episode, not two — a crash loop must not produce five reports
    expect(log.events).toHaveLength(1)
    expect(log.events[0].at).toBe(T0 + DEDUPE_MS - 1) // newest timestamp wins
  })

  it('keeps a repeat of the same kind outside the dedupe window', () => {
    let log = foldTrouble(EMPTY_LOG, 'crash', T0)
    log = foldTrouble(log, 'crash', T0 + DEDUPE_MS + 1)
    expect(log.events).toHaveLength(2)
  })

  it('keeps different kinds apart even inside the window', () => {
    let log = foldTrouble(EMPTY_LOG, 'crash', T0)
    log = foldTrouble(log, 'storageFull', T0 + 1000)
    expect(log.events.map((e) => e.kind).sort()).toEqual(['crash', 'storageFull'])
  })

  it('drops stale events as it folds', () => {
    let log = foldTrouble(EMPTY_LOG, 'crash', T0)
    log = foldTrouble(log, 'storageFull', T0 + STALE_MS + 1)
    expect(log.events).toEqual([{ kind: 'storageFull', at: T0 + STALE_MS + 1 }])
  })

  it('caps the log and drops the OLDEST', () => {
    let log = EMPTY_LOG
    for (let i = 0; i < MAX_EVENTS + 3; i++) {
      // spaced past the dedupe window so each is its own episode
      log = foldTrouble(log, 'crash', T0 + i * (DEDUPE_MS + 1))
    }
    expect(log.events).toHaveLength(MAX_EVENTS)
    const oldest = Math.min(...log.events.map((e) => e.at))
    expect(oldest).toBe(T0 + 3 * (DEDUPE_MS + 1))
  })

  it('preserves askedAt across folds', () => {
    const log = foldTrouble({ events: [], askedAt: T0 }, 'crash', T0 + 1000)
    expect(log.askedAt).toBe(T0)
  })
})

describe('pickTrouble', () => {
  it('returns null on an empty log', () => {
    expect(pickTrouble(EMPTY_LOG, T0)).toBeNull()
  })

  it('picks the most severe, not the most recent', () => {
    const log: TroubleLog = {
      events: [
        { kind: 'syncConflict', at: T0 + 5000 },
        { kind: 'crashLoop', at: T0 },
        { kind: 'storageFull', at: T0 + 9000 },
      ],
    }
    expect(pickTrouble(log, T0 + 10_000)?.kind).toBe('crashLoop')
  })

  it('breaks severity ties by recency', () => {
    const log: TroubleLog = {
      events: [{ kind: 'crash', at: T0 }, { kind: 'crash', at: T0 + 5000 }],
    }
    expect(pickTrouble(log, T0 + 6000)?.at).toBe(T0 + 5000)
  })

  it('stays silent inside the cooldown, however bad the trouble', () => {
    const log: TroubleLog = { events: [{ kind: 'crashLoop', at: T0 }], askedAt: T0 - 1000 }
    expect(pickTrouble(log, T0)).toBeNull()
  })

  it('asks again once the cooldown has passed', () => {
    const log: TroubleLog = { events: [{ kind: 'crash', at: T0 }], askedAt: T0 - COOLDOWN_MS }
    expect(pickTrouble(log, T0)?.kind).toBe('crash')
  })

  it('ignores events too old to remember', () => {
    const log: TroubleLog = { events: [{ kind: 'crash', at: T0 }] }
    expect(pickTrouble(log, T0 + STALE_MS + 1)).toBeNull()
  })
})

describe('markAsked', () => {
  it('clears the log and starts the cooldown, so the same crash cannot return', () => {
    const next = markAsked(T0)
    expect(next).toEqual({ events: [], askedAt: T0 })
    expect(pickTrouble(next, T0 + 1000)).toBeNull()
  })
})

// These run in the default node environment (fast, no jsdom) with a minimal in-memory Storage:
// what is under test is our own write/read/validation, not the browser's implementation.
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

describe('persistence', () => {
  beforeAll(() => {
    ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
  })
  beforeEach(() => localStorage.clear())

  it('round-trips through localStorage', () => {
    recordTrouble('crash', T0)
    expect(readTrouble().events).toEqual([{ kind: 'crash', at: T0 }])
  })

  it('markTroubleAsked persists the cooldown', () => {
    recordTrouble('crash', T0)
    markTroubleAsked(T0)
    expect(readTrouble()).toEqual({ events: [], askedAt: T0 })
  })

  it('treats unparseable storage as no history instead of throwing', () => {
    localStorage.setItem('kp-front-trouble', '{not json')
    expect(readTrouble()).toEqual(EMPTY_LOG)
  })

  it('drops records of an unknown kind (older build, hand-edited storage)', () => {
    localStorage.setItem(
      'kp-front-trouble',
      JSON.stringify({ events: [{ kind: 'martians', at: T0 }, { kind: 'crash', at: T0 }] }),
    )
    expect(readTrouble().events).toEqual([{ kind: 'crash', at: T0 }])
  })

  it('recordTrouble never throws when storage is unavailable', () => {
    // A full disk (or Safari private mode) must not turn the diagnostics path into the crash.
    const ls = localStorage as unknown as { setItem: (k: string, v: string) => void }
    const orig = ls.setItem
    ls.setItem = () => { throw new Error('quota') }
    try {
      expect(() => recordTrouble('crash', T0)).not.toThrow()
    } finally {
      ls.setItem = orig
    }
  })
})
