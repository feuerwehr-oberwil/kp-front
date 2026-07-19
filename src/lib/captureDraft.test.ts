import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearDraft, loadDraft, makeDebouncedFlush, restoreDraft, saveDraft, serverSkewMinutes,
  type DraftStore,
} from './captureDraft'

const memStore = (): DraftStore & { raw: Map<string, string> } => {
  const raw = new Map<string, string>()
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => { raw.set(k, v) },
    removeItem: (k) => { raw.delete(k) },
  }
}

describe('capture drafts', () => {
  it('round-trips per incident+field and clears', () => {
    const store = memStore()
    saveDraft(store, 'i1', 'summary', 'Brand im Keller')
    saveDraft(store, 'i2', 'summary', 'anderer Einsatz')
    expect(loadDraft(store, 'i1', 'summary')).toBe('Brand im Keller')
    expect(loadDraft(store, 'i2', 'summary')).toBe('anderer Einsatz')
    clearDraft(store, 'i1', 'summary')
    expect(loadDraft(store, 'i1', 'summary')).toBeNull()
    expect(loadDraft(store, 'i2', 'summary')).toBe('anderer Einsatz')
  })

  it('restoreDraft prefers a differing draft, else the saved value', () => {
    const store = memStore()
    expect(restoreDraft(store, 'i1', 'summary', 'gespeichert')).toBe('gespeichert')
    saveDraft(store, 'i1', 'summary', 'gespeichert') // identical → not "newer"
    expect(restoreDraft(store, 'i1', 'summary', 'gespeichert')).toBe('gespeichert')
    saveDraft(store, 'i1', 'summary', 'gespeichert und mehr')
    expect(restoreDraft(store, 'i1', 'summary', 'gespeichert')).toBe('gespeichert und mehr')
  })

  it('tolerates corrupt payloads', () => {
    const store = memStore()
    store.setItem('kp.capture.draft.i1.summary', 'not json')
    expect(loadDraft(store, 'i1', 'summary')).toBeNull()
    store.setItem('kp.capture.draft.i1.summary', JSON.stringify({ v: 42 }))
    expect(loadDraft(store, 'i1', 'summary')).toBeNull()
  })
})

describe('serverSkewMinutes', () => {
  it('rounds device-minus-server to whole minutes', () => {
    const server = '2026-07-18T10:00:00Z'
    expect(serverSkewMinutes(server, Date.parse('2026-07-18T10:05:00Z'))).toBe(5)
    expect(serverSkewMinutes(server, Date.parse('2026-07-18T09:56:00Z'))).toBe(-4)
    expect(serverSkewMinutes(server, Date.parse('2026-07-18T10:00:20Z'))).toBe(0)
  })

  it('returns null for an unparseable header', () => {
    expect(serverSkewMinutes('garbage', Date.now())).toBeNull()
  })
})

describe('makeDebouncedFlush', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('flushes only the latest value once the delay elapses', async () => {
    const flushed: number[] = []
    const f = makeDebouncedFlush<number>(600, async (v) => { flushed.push(v) })
    f.push(1)
    f.push(2)
    await vi.advanceTimersByTimeAsync(599)
    expect(flushed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(flushed).toEqual([2])
  })

  it('chains a value pushed during an in-flight flush (never drops, never overlaps)', async () => {
    const flushed: number[] = []
    const releases: (() => void)[] = []
    const f = makeDebouncedFlush<number>(100, (v) => new Promise<void>((res) => { flushed.push(v); releases.push(res) }))
    f.push(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(flushed).toEqual([1])
    f.push(2)
    await vi.advanceTimersByTimeAsync(100) // timer fires while 1 is still in flight
    expect(flushed).toEqual([1]) // not concurrent
    releases[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(flushed).toEqual([1, 2]) // chained right after the first settles
    releases[1]()
  })

  it('flushNow flushes pending immediately and is a no-op when clean', async () => {
    const flushed: number[] = []
    const f = makeDebouncedFlush<number>(500, async (v) => { flushed.push(v) })
    f.push(7)
    await f.flushNow()
    expect(flushed).toEqual([7])
    await f.flushNow()
    expect(flushed).toEqual([7])
  })

  it('cancel drops the pending value', async () => {
    const flushed: number[] = []
    const f = makeDebouncedFlush<number>(100, async (v) => { flushed.push(v) })
    f.push(1)
    f.cancel()
    await vi.advanceTimersByTimeAsync(1000)
    expect(flushed).toEqual([])
  })

  it('swallows flush rejections (caller surfaces errors)', async () => {
    let calls = 0
    const f = makeDebouncedFlush<number>(10, async () => { calls += 1; throw new Error('boom') })
    f.push(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toBe(1)
  })
})
