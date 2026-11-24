// Hunt 24.11.2026, performance F2: the Wiedergabe asks for a state four times a second; each ask
// downloaded the whole snapshot. One request per ANCHOR now – it serves every instant up to the
// next snapshot, and an ask while one request is out waits for it.
import { beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ snapshot: [] as string[] }))
vi.mock('./api', () => ({
  apiGet: async (path: string) => {
    if (path.includes('/snapshot')) {
      calls.snapshot.push(path)
      await new Promise((r) => setTimeout(r, 5))
      const at = decodeURIComponent(path.split('at=')[1])
      // snapshots at 10:00 and 10:30
      if (at < '2026-11-24T10:00:00.000Z') return { found: false, occurred_at: null, seq_at: null, workspace: null, next_at: '2026-11-24T10:00:00Z' }
      const late = at >= '2026-11-24T10:30:00.000Z'
      return {
        found: true, seq_at: late ? 2 : 1, workspace: { entities: [] },
        occurred_at: late ? '2026-11-24T10:30:00Z' : '2026-11-24T10:00:00Z',
        next_at: late ? null : '2026-11-24T10:30:00Z',
      }
    }
    return []
  },
}))

// the server's «now» when the last anchor is fetched: it serves up to here, no further
vi.mock('./serverClock', () => ({ serverNow: () => Date.parse('2026-11-24T11:00:00Z') }))

const { loadReplay } = await import('./replay')
const t = (hhmm: string) => Date.parse(`2026-11-24T${hhmm}:00Z`)

beforeEach(() => { calls.snapshot = [] })

it('one request per snapshot interval, however many frames ask', async () => {
  const bundle = await loadReplay('i', t('09:00'), t('11:00'))
  // a second of playback at 4 frames a second, all inside the 10:00 interval – asked at once
  const frames = await Promise.all([0, 1, 2, 3, 4].map((s) => bundle.loadSnapshotAt(t('10:05') + s * 250)))
  expect(frames.every((f) => f.occurredMs === t('10:00'))).toBe(true)
  expect(calls.snapshot).toHaveLength(1)
  // still inside the interval later: no request
  await bundle.loadSnapshotAt(t('10:29'))
  expect(calls.snapshot).toHaveLength(1)
  // the next interval, and before the first snapshot: one request each, then cached
  expect((await bundle.loadSnapshotAt(t('10:45'))).occurredMs).toBe(t('10:30'))
  expect((await bundle.loadSnapshotAt(t('09:30'))).occurredMs).toBeNull()
  await bundle.loadSnapshotAt(t('10:50'))
  await bundle.loadSnapshotAt(t('09:40'))
  expect(calls.snapshot).toHaveLength(3)
})

it('the last anchor holds only up to when it was asked for, and fine stamps round up', async () => {
  const bundle = await loadReplay('i', t('09:00'), t('12:00'))
  await bundle.loadSnapshotAt(t('10:40'))
  await bundle.loadSnapshotAt(t('10:59'))
  expect(calls.snapshot).toHaveLength(1)
  // a snapshot another tablet takes later may exist past the moment we asked: ask again
  await bundle.loadSnapshotAt(t('11:30'))
  expect(calls.snapshot).toHaveLength(2)
})

