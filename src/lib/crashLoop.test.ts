import { beforeEach, describe, expect, it } from 'vitest'
import { CRASH_HEALTHY_MS, CRASH_WINDOW_MS, clearCrash, foldCrash, isLooping, readCrash, recordCrash } from './crashLoop'

// The whole point of this counter is that a SECOND crash on the same Einsatz unlocks the
// destructive recovery, because at that point «Neu laden» has demonstrably failed (boot
// auto-reopens the incident). Getting the streak logic wrong either strands the operator in
// the loop (never escalates) or offers to throw away unsynced edits far too eagerly.

const T0 = 1_700_000_000_000

describe('foldCrash — streak accounting', () => {
  it('starts a streak at 1', () => {
    expect(foldCrash(null, 'inc-1', T0)).toEqual({ id: 'inc-1', n: 1, at: T0 })
  })

  it('increments for the same incident inside the window', () => {
    const first = foldCrash(null, 'inc-1', T0)
    expect(foldCrash(first, 'inc-1', T0 + 5_000)).toMatchObject({ id: 'inc-1', n: 2 })
  })

  it('restarts for a DIFFERENT incident (an unrelated crash inherits no streak)', () => {
    const first = foldCrash(null, 'inc-1', T0)
    expect(foldCrash(first, 'inc-2', T0 + 5_000)).toMatchObject({ id: 'inc-2', n: 1 })
  })

  it('restarts once the window has lapsed', () => {
    const first = foldCrash(null, 'inc-1', T0)
    expect(foldCrash(first, 'inc-1', T0 + CRASH_WINDOW_MS + 1)).toMatchObject({ n: 1 })
  })

  it('always advances the timestamp so a slow loop keeps the streak alive', () => {
    let rec = foldCrash(null, 'inc-1', T0)
    for (let i = 1; i <= 3; i++) rec = foldCrash(rec, 'inc-1', T0 + i * (CRASH_WINDOW_MS - 1_000))
    expect(rec.n).toBe(4)
  })
})

describe('isLooping — when to offer the destructive recovery', () => {
  it('stays false on a first crash (the lossless escape is enough)', () => {
    expect(isLooping(foldCrash(null, 'inc-1', T0), 'inc-1', T0)).toBe(false)
  })

  it('turns true on the second crash of the same incident', () => {
    const rec = foldCrash(foldCrash(null, 'inc-1', T0), 'inc-1', T0 + 1_000)
    expect(isLooping(rec, 'inc-1', T0 + 1_000)).toBe(true)
  })

  it('does not leak across incidents', () => {
    const rec = foldCrash(foldCrash(null, 'inc-1', T0), 'inc-1', T0 + 1_000)
    expect(isLooping(rec, 'inc-2', T0 + 1_000)).toBe(false)
  })

  it('expires with the window, and is false with no history at all', () => {
    const rec = foldCrash(foldCrash(null, 'inc-1', T0), 'inc-1', T0 + 1_000)
    expect(isLooping(rec, 'inc-1', T0 + 1_000 + CRASH_WINDOW_MS + 1)).toBe(false)
    expect(isLooping(null, 'inc-1', T0)).toBe(false)
  })
})

// Same minimal stub the storageMigration test uses — these run in the default node env.
function installLocalStorage() {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  } as Storage
}

describe('persistence — must survive the reload the operator just triggered', () => {
  beforeEach(() => { installLocalStorage() })

  it('round-trips a recorded crash and escalates across two separate reads', () => {
    expect(recordCrash('inc-1', T0)).toMatchObject({ n: 1 })
    expect(readCrash()).toMatchObject({ id: 'inc-1', n: 1 })
    // second crash after the reload → n=2 → destructive recovery unlocks
    expect(recordCrash('inc-1', T0 + 2_000)).toMatchObject({ n: 2 })
    expect(isLooping(readCrash(), 'inc-1', T0 + 2_000)).toBe(true)
  })

  it('clearCrash forgets the streak (healthy mount / successful recovery)', () => {
    recordCrash('inc-1', T0)
    clearCrash()
    expect(readCrash()).toBeNull()
  })

  it('ignores a corrupt/foreign stored value instead of throwing', () => {
    localStorage.setItem('kp-front-crash', '{not json')
    expect(readCrash()).toBeNull()
    localStorage.setItem('kp-front-crash', JSON.stringify({ id: 'x' })) // missing n/at
    expect(readCrash()).toBeNull()
  })

  it('records a crash outside any incident under the empty scope', () => {
    expect(recordCrash('', T0)).toMatchObject({ id: '', n: 1 })
  })
})

describe('CRASH_HEALTHY_MS — when App forgets a streak on its own', () => {
  // A crash that only happens once a surface is opened — minutes after the reload that
  // reproduces it — must still find its predecessor. A healthy window shorter than the crash
  // window restarted the count at one on every round, and the destructive recovery never came.
  it('outlasts the crash window', () => {
    expect(CRASH_HEALTHY_MS).toBeGreaterThanOrEqual(CRASH_WINDOW_MS)
  })
})
