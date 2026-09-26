import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Atemschutz-Link session writes the Überwachungstafel and nothing else — the full
// workspace PUT 403s for it. What is worth pinning is that `slice: 'trupps'` changes ONLY the
// route the push takes: the same engine, the same base_rev, and never a whole-blob write that
// the server would refuse (leaving a link holder's Kontakt stuck in the offline cache).
const getWorkspace = vi.fn()
const putWorkspace = vi.fn()
const putWorkspaceBeacon = vi.fn()
const putWorkspaceTrupps = vi.fn()
const putWorkspaceTruppsBeacon = vi.fn()
const putWorkspaceRecord = vi.fn()
const putWorkspaceRecordBeacon = vi.fn()
vi.mock('./workspace', () => ({
  getWorkspace: (...a: unknown[]) => getWorkspace(...a),
  putWorkspace: (...a: unknown[]) => putWorkspace(...a),
  putWorkspaceBeacon: (...a: unknown[]) => putWorkspaceBeacon(...a),
  putWorkspaceTrupps: (...a: unknown[]) => putWorkspaceTrupps(...a),
  putWorkspaceTruppsBeacon: (...a: unknown[]) => putWorkspaceTruppsBeacon(...a),
  putWorkspaceRecord: (...a: unknown[]) => putWorkspaceRecord(...a),
  putWorkspaceRecordBeacon: (...a: unknown[]) => putWorkspaceRecordBeacon(...a),
}))
vi.mock('../idb', () => {
  const idbGet = vi.fn(async (_key: string): Promise<unknown> => null)
  return {
    idbGet,
    // the hydrate paths read through `idbRead`; it answers from the same mocked store
    idbRead: vi.fn(async (key: string) => ({ ok: true, value: await idbGet(key) })),
    idbSet: vi.fn(async () => true),
    idbDel: vi.fn(async () => undefined),
  }
})
vi.mock('../tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))

const { ApiError } = await import('../api')
const { idbSet } = vi.mocked(await import('../idb'))
const { CACHE_DEBOUNCE_MS, CONFLICT_ATTEMPTS, CONFLICT_BACKOFF_MS, WorkspaceSync, conflictBackoffMs } = await import('./workspaceSync')

const trupp = { id: 'tr1', name: 'Trupp 1', status: 'aktiv' }
const blob = { trupps: [trupp], drawings: [{ id: 'd1' }] }

beforeEach(() => {
  getWorkspace.mockReset().mockResolvedValue({ workspace: {}, workspace_rev: 7 })
  putWorkspace.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 8 })
  putWorkspaceBeacon.mockReset()
  putWorkspaceTrupps.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 8 })
  putWorkspaceTruppsBeacon.mockReset()
  putWorkspaceRecord.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 8 })
  putWorkspaceRecordBeacon.mockReset()
  idbSet.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('WorkspaceSync · slice: «trupps»', () => {
  it('pushes only the Trupps, at the revision the whole blob is based on', async () => {
    const sync = new WorkspaceSync('i1', { slice: 'trupps', debounceMs: 0 })
    await sync.init()
    sync.save(blob)
    await sync.flush()
    expect(putWorkspaceTrupps).toHaveBeenCalledWith('i1', [trupp], 7, expect.stringMatching(/^\d{4}-\d\d-\d\dT/))
    expect(putWorkspace).not.toHaveBeenCalled()
    sync.dispose()
  })

  it('sends the teardown beacon down the same slice route', async () => {
    const sync = new WorkspaceSync('i1', { slice: 'trupps', debounceMs: 10_000 })
    await sync.init()
    sync.save(blob)
    sync.flushKeepalive()
    expect(putWorkspaceTruppsBeacon).toHaveBeenCalledWith('i1', [trupp], 7, expect.stringMatching(/^\d{4}-\d\d-\d\dT/))
    expect(putWorkspaceBeacon).not.toHaveBeenCalled()
    sync.dispose()
  })

  // The `el` role's slice (07.09.): only the record keys travel, and only its route is taken —
  // the blob's tactical keys must never appear in the payload, whatever the local state holds.
  const recordBlob = {
    attendance: { p1: { status: 'present' } }, mittel: [{ id: 'm1' }], checklists: { t1: {} },
    reportMeta: { einsatzort: 'X' }, entities: [{ id: 'e1' }], drawings: [{ id: 'd1' }], trupps: [trupp],
  }

  it('slice: «record» pushes the record keys only, never the map', async () => {
    const sync = new WorkspaceSync('i1', { slice: 'record', debounceMs: 0 })
    await sync.init()
    sync.save(recordBlob)
    await sync.flush()
    expect(putWorkspaceRecord).toHaveBeenCalledWith('i1', {
      attendance: { p1: { status: 'present' } }, mittel: [{ id: 'm1' }], checklists: { t1: {} },
      reportMeta: { einsatzort: 'X' },
    }, 7)
    expect(putWorkspace).not.toHaveBeenCalled()
    expect(putWorkspaceTrupps).not.toHaveBeenCalled()
    sync.dispose()
  })

  it('sends the record teardown beacon down the same slice route', async () => {
    const sync = new WorkspaceSync('i1', { slice: 'record', debounceMs: 10_000 })
    await sync.init()
    sync.save({ ...recordBlob, attachments: [{ id: 'a1' }] })
    sync.flushKeepalive()
    expect(putWorkspaceRecordBeacon).toHaveBeenCalledWith('i1', expect.objectContaining({ attachments: [{ id: 'a1' }] }), 7)
    expect(putWorkspaceRecordBeacon.mock.calls[0][1]).not.toHaveProperty('entities')
    expect(putWorkspaceBeacon).not.toHaveBeenCalled()
    sync.dispose()
  })

  // …and an ordinary editor session is untouched by any of it.
  it('writes the whole document without the option', async () => {
    const sync = new WorkspaceSync('i1', { debounceMs: 0 })
    await sync.init()
    sync.save(blob)
    await sync.flush()
    expect(putWorkspace).toHaveBeenCalledWith('i1', blob, 7, expect.stringMatching(/^\d{4}-\d\d-\d\dT/))
    expect(putWorkspaceTrupps).not.toHaveBeenCalled()
    sync.dispose()
  })
})

// The 409 resolver used to run its GET and its merge OUTSIDE the try: a server blob this app
// did not write (`entities: {}`) threw in the merge, the throw escaped flush() as an unhandled
// rejection, no status was ever set, and the backoff re-threw it every 5–60 s — the badge stuck
// on «ausstehend» with no toast. Now the merge coerces, and whatever still fails lands in a
// status the UI answers with the sync toast and «Jetzt synchronisieren».
describe('WorkspaceSync · the 409 resolver', () => {
  const conflict = () => new ApiError(409, 'stale')

  it('a server blob with entities: {} merges without throwing and pushes an empty list', async () => {
    putWorkspace.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ workspace: null, workspace_rev: 10 })
    getWorkspace.mockResolvedValueOnce({ workspace: {}, workspace_rev: 7 }).mockResolvedValueOnce({ workspace: { entities: {} }, workspace_rev: 9 })
    const status: string[] = []
    const sync = new WorkspaceSync('i1', { debounceMs: 0 })
    sync.onStatus = (s) => status.push(s)
    await sync.init()
    sync.save({ entities: [] })
    await sync.flush()
    const merged = putWorkspace.mock.calls[1][1] as { entities: unknown }
    expect(merged.entities).toEqual([])
    expect(putWorkspace.mock.calls[1][2]).toBe(9)
    expect(status[status.length - 1]).toBe('synced')
    sync.dispose()
  })

  it('a fetch that dies inside the resolver lands in «offline», a merge that throws in «error» — never an unhandled rejection', async () => {
    putWorkspace.mockRejectedValue(conflict())
    getWorkspace.mockResolvedValueOnce({ workspace: {}, workspace_rev: 7 }).mockRejectedValueOnce(new ApiError(0, 'network'))
    const status: string[] = []
    const sync = new WorkspaceSync('i1', { debounceMs: 0 })
    sync.onStatus = (s) => status.push(s)
    await sync.init()
    sync.save({ entities: [] })
    await expect(sync.flush()).resolves.toBeUndefined()
    expect(status[status.length - 1]).toBe('offline')
    expect(sync.hasUnsynced).toBe(true) // the edits stay dirty in the cache for the retry

    getWorkspace.mockRejectedValueOnce(new Error('boom'))
    await expect(sync.flush()).resolves.toBeUndefined()
    expect(status[status.length - 1]).toBe('error')
    sync.dispose()
  })

  // ⚠️ Found by the three-device load test (24.09.2026): a local edit saved while the merge PUT
  // 409s again is built on the live view, which never saw that merge — it lacks the remote
  // objects the merge brought in, while `base` (the server copy the merge was made against) has
  // them. Merged as-is, the next attempt read their absence as a local delete and removed another
  // device's work from the server (7–14 % of edits in the load test, with or without the jitter).
  it('an edit saved while a re-merge is 409ing is re-based onto that merge — no remote object is deleted', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // shortest backoff (125 ms, real timers)
    const sync = new WorkspaceSync('i1', { debounceMs: 0 })
    await sync.init() // rev 7, empty
    sync.save({ cameraViews: [{ id: 'm1' }] })
    putWorkspace
      .mockRejectedValueOnce(conflict()) // the original push: another device landed r1
      .mockImplementationOnce(async () => {
        // the merge PUT is in flight: the operator adds m2 on the view that has no r1 yet…
        sync.save({ cameraViews: [{ id: 'm1' }, { id: 'm2' }] })
        throw conflict() // …and a third device landed r2 meanwhile
      })
      .mockResolvedValueOnce({ workspace: null, workspace_rev: 11 })
    getWorkspace
      .mockResolvedValueOnce({ workspace: { cameraViews: [{ id: 'r1' }] }, workspace_rev: 9 })
      .mockResolvedValueOnce({ workspace: { cameraViews: [{ id: 'r1' }, { id: 'r2' }] }, workspace_rev: 10 })
    await sync.flush()
    const last = putWorkspace.mock.calls[putWorkspace.mock.calls.length - 1]
    expect(last[2]).toBe(10)
    expect((last[1] as { cameraViews: { id: string }[] }).cameraViews.map((v) => v.id).sort()).toEqual(['m1', 'm2', 'r1', 'r2'])
    sync.dispose()
    vi.restoreAllMocks()
  })
})

// D4 of the 23.09.2026 post-mortem: 409 re-merges ran back-to-back with no pause, so three
// devices on one login retried in lock-step. The pause is jittered and bounded.
describe('conflictBackoffMs', () => {
  it('the first merge after a 409 goes at once; re-merges wait base·2^(n−1) × [0.5, 1.5)', () => {
    expect(conflictBackoffMs(0, () => 0.99)).toBe(0)
    const bounds = [[1, 125, 375], [2, 250, 750], [3, 500, 1500]] as const
    for (const [attempt, lo, hi] of bounds) {
      expect(conflictBackoffMs(attempt, () => 0)).toBe(lo)
      expect(conflictBackoffMs(attempt, () => 0.999999)).toBeLessThanOrEqual(hi)
      for (let i = 0; i < 200; i++) {
        const ms = conflictBackoffMs(attempt)
        expect(ms).toBeGreaterThanOrEqual(lo)
        expect(ms).toBeLessThanOrEqual(hi)
      }
    }
    expect(CONFLICT_BACKOFF_MS).toBe(250)
    expect(CONFLICT_ATTEMPTS).toBe(4)
  })

  it('actually spreads: two devices drawing different randoms wait different times', () => {
    expect(conflictBackoffMs(1, () => 0.1)).not.toBe(conflictBackoffMs(1, () => 0.9))
  })
})

// The offline cache used to be written on EVERY save() — a structured clone plus an IDB put of
// the whole blob per keystroke, and on a full device a 500-tile eviction per key.
describe('WorkspaceSync · the cache write is debounced', () => {
  it('a burst of saves lands once, with the latest content, after the debounce', async () => {
    vi.useFakeTimers()
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS) // init's own write
    idbSet.mockClear()
    sync.save({ n: 1 }); sync.save({ n: 2 }); sync.save({ n: 3 })
    expect(idbSet).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
    expect(idbSet).toHaveBeenCalledTimes(1)
    expect(idbSet.mock.calls[0][1]).toMatchObject({ workspace: { n: 3 }, dirty: true })
    sync.dispose()
  })

  it('teardown and the server push flush it synchronously — the debounce never loses the last edit', async () => {
    vi.useFakeTimers()
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
    idbSet.mockClear()
    sync.save({ n: 1 })
    sync.flushKeepalive()
    expect(idbSet).toHaveBeenCalledTimes(1) // no timer advance needed
    expect(idbSet.mock.calls[0][1]).toMatchObject({ workspace: { n: 1 } })

    sync.save({ n: 2 })
    await sync.flush() // the push flushes first, then writes the synced entry (debounced again)
    expect(idbSet.mock.calls[1][1]).toMatchObject({ workspace: { n: 2 }, dirty: true })
    await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
    expect(idbSet.mock.calls[2][1]).toMatchObject({ workspace: { n: 2 }, dirty: false })

    sync.save({ n: 3 })
    sync.dispose()
    expect(idbSet).toHaveBeenCalledTimes(4)
    expect(idbSet.mock.calls[3][1]).toMatchObject({ workspace: { n: 3 } })
  })
})


// ⚠️ A save made without a compare (useIncidentSync's mid-gesture skip, which a caret left in a
// field also triggers) used to restart the 3 s debounce like any other: churn faster than that
// held the push back for as long as it lasted (review 24.09.2026).
describe('WorkspaceSync · keepTimer', () => {
  it('saves that keep the timer push at the time the first one armed, however fast they come', async () => {
    vi.useFakeTimers()
    const sync = new WorkspaceSync('i1', { debounceMs: 3_000 })
    await sync.init()
    sync.save({ n: 0 })
    for (let i = 1; i <= 7; i++) { // every 500 ms, for 3.5 s
      await vi.advanceTimersByTimeAsync(500)
      sync.save({ n: i }, { keepTimer: true })
    }
    expect(putWorkspace).toHaveBeenCalledTimes(1) // at 3 s, not «3 s after the churn stops»
    expect(putWorkspace.mock.calls[0][1]).toEqual({ n: 5 })
    sync.dispose()
  })

  it('an ordinary save still restarts it', async () => {
    vi.useFakeTimers()
    const sync = new WorkspaceSync('i1', { debounceMs: 3_000 })
    await sync.init()
    for (let i = 0; i <= 5; i++) {
      sync.save({ n: i })
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(putWorkspace).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(putWorkspace).toHaveBeenCalledTimes(1)
    sync.dispose()
  })
})

describe('WorkspaceSync – awaited flush', () => {
  it('joins the in-flight PUT and waits for the newer edit sent after its acknowledgement', async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let secondStarted!: () => void
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const second = new Promise<void>((resolve) => { releaseSecond = resolve })
    const enteredSecond = new Promise<void>((resolve) => { secondStarted = resolve })
    putWorkspace.mockImplementationOnce(async () => { await first; return { workspace_rev: 8 } })
      .mockImplementationOnce(async () => { secondStarted(); await second; return { workspace_rev: 9 } })
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    sync.save({ n: 1 })
    const automatic = sync.flush()
    sync.save({ n: 2 })
    let completed = false
    const manual = sync.flush().then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    releaseFirst()
    await enteredSecond
    expect(completed).toBe(false)
    releaseSecond()
    await Promise.all([automatic, manual])
    expect(putWorkspace).toHaveBeenLastCalledWith('i1', { n: 2 }, 8, expect.stringMatching(/^\d{4}-\d\d-\d\dT/))
    expect(sync.syncStatus).toBe('synced')
    sync.dispose()
  })

  // A flush that JOINS a failing attempt is owed one attempt of its own (the journal's rule,
  // #209) — and no more: an offline device does not spin, and the backoff still follows.
  it('a joined flush gets one attempt of its own after a failure, then the automatic retry delay', async () => {
    vi.useFakeTimers()
    putWorkspace.mockRejectedValue(new ApiError(0, 'offline'))
    const sync = new WorkspaceSync('i1')
    await sync.init()
    sync.save({ n: 1 })
    await Promise.all([sync.flush(), sync.flush()])
    expect(putWorkspace).toHaveBeenCalledTimes(2)
    expect(sync.syncStatus).toBe('offline')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(putWorkspace).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(putWorkspace).toHaveBeenCalledTimes(3)
    sync.dispose()
  })
})

describe('WorkspaceSync · a flush asked for while a failing attempt is in flight', () => {
  // #209's failure mode (a) for the workspace: the `online` handler / the reach signal / «Jetzt
  // synchronisieren» arrived while the PUT sent before the reconnect was still settling, joined
  // it, and the edits then sat out the backoff (5–60 s) although the link was back.
  it('gets its own attempt once the in-flight one fails, and delivers', async () => {
    let failInFlight!: () => void
    putWorkspace.mockImplementationOnce(() => new Promise((_, reject) => { failInFlight = () => reject(new ApiError(0, 'offline')) }))
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    sync.save({ n: 1 })
    const doomed = sync.flush() // the PUT that is about to fail
    const reconnect = sync.flush() // …and the link is back: somebody asks again meanwhile
    failInFlight()
    await Promise.all([doomed, reconnect])
    expect(putWorkspace).toHaveBeenCalledTimes(2)
    expect(putWorkspace).toHaveBeenLastCalledWith('i1', { n: 1 }, 7, expect.stringMatching(/^\d{4}-\d\d-\d\dT/))
    expect(sync.hasUnsynced).toBe(false)
    expect(sync.syncStatus).toBe('synced')
    sync.dispose()
  })

  it('a failed attempt nobody asked to repeat is not repeated (an offline device does not spin)', async () => {
    vi.useFakeTimers()
    putWorkspace.mockRejectedValue(new ApiError(0, 'offline'))
    const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
    await sync.init()
    sync.save({ n: 1 })
    await sync.flush()
    expect(putWorkspace).toHaveBeenCalledTimes(1)
    await sync.flush()
    expect(putWorkspace).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000) // below the first backoff step: nothing by itself
    expect(putWorkspace).toHaveBeenCalledTimes(2)
    expect(sync.hasUnsynced).toBe(true)
    expect(sync.syncStatus).toBe('offline')
    sync.dispose()
  })
})
