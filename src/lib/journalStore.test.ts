import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the HTTP layer (same pattern as incidents.test.ts): the store calls apiGet/apiPost.
const { apiGet, apiPost, apiBeacon } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiBeacon: vi.fn() }))
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, apiGet, apiPost, apiBeacon }
})

import { ApiError } from './api'
import { __resetIdbForTests } from './idb'
import { JournalStore } from './journalStore'
import type { TimelineEvent } from '../types'

const INC = 'inc-1'
const row = (id: string, over: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id, t: '14:00', at: '2026-07-02T14:00:00Z', icon: 'flag', text: `Zeile ${id}`, ...over })

// server double: accepts batches idempotently, serves since_seq pages
function fakeServer(initial: TimelineEvent[] = []) {
  const rows: { seq: number; row: TimelineEvent }[] = initial.map((r, i) => ({ seq: i + 1, row: r }))
  apiPost.mockImplementation(async (_path: string, body: { entries: TimelineEvent[] }) => {
    const have = new Set(rows.map((r) => r.row.id))
    const accepted: { seq: number; row: TimelineEvent }[] = []
    for (const e of body.entries) {
      if (have.has(e.id)) continue
      have.add(e.id)
      const entry = { seq: rows.length + 1, row: e }
      rows.push(entry)
      accepted.push(entry)
    }
    return { entries: accepted, latest_seq: rows.length ? rows[rows.length - 1].seq : 0 }
  })
  apiGet.mockImplementation(async (path: string) => {
    const since = Number(/since_seq=(\d+)/.exec(path)?.[1] ?? 0)
    const page = rows.filter((r) => r.seq > since)
    return { entries: page, latest_seq: page.length ? page[page.length - 1].seq : since }
  })
  return { rows }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  apiGet.mockReset()
  apiPost.mockReset()
  apiBeacon.mockReset()
})

describe('JournalStore — append/flush/pull', () => {
  it('appends rows, flushes them to the server, displays newest-first', async () => {
    fakeServer()
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('a'))
    s.append(row('b'))
    await settle(); await settle()

    expect(s.pendingCount).toBe(0)
    expect(s.display().map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('keeps rows in the outbox while offline and drains them on the next flush', async () => {
    apiGet.mockRejectedValue(new ApiError(0, 'offline'))
    apiPost.mockRejectedValue(new ApiError(0, 'offline'))
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('a'))
    await settle()
    expect(s.pendingCount).toBe(1)
    expect(s.display().map((r) => r.id)).toEqual(['a'])

    fakeServer()
    await s.flush()
    expect(s.pendingCount).toBe(0)
  })

  it('a flush NEVER advances the pull cursor — rows other devices appended in between still arrive', async () => {
    const srv = fakeServer([row('x')]) // seq 1
    const s = new JournalStore(INC, false)
    await s.init([]) // cursor at 1
    // another device appends seq 2 …
    srv.rows.push({ seq: 2, row: row('y') })
    // … then WE flush a row (server assigns seq 3, response says latest_seq=3)
    s.append(row('mine'))
    await settle(); await settle(); await settle()
    // if flush had jumped the cursor to 3, 'y' would be unreachable; it must still arrive
    await s.pull()
    expect(s.display().some((r) => r.id === 'y')).toBe(true)
  })

  it('a lost-response retry (idempotent skip) still converges — the rows arrive via pull', async () => {
    const srv = fakeServer()
    // first POST: server applies the write but the response is lost
    apiPost.mockImplementationOnce(async (_p: string, body: { entries: TimelineEvent[] }) => {
      for (const e of body.entries) srv.rows.push({ seq: srv.rows.length + 1, row: e })
      throw new ApiError(0, 'response lost')
    })
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('a'))
    await settle()
    expect(s.pendingCount).toBe(1) // network error → still queued

    await s.flush() // retry hits the idempotent skip (accepted=[])
    await settle()
    expect(s.pendingCount).toBe(0)
    await s.pull() // cursor never moved past the row, so pull fetches it
    expect(s.display().map((r) => r.id)).toEqual(['a'])
  })

  it('a row the server rejects (422) is dead-lettered; the rest of the journal keeps flowing', async () => {
    const srv = fakeServer()
    const good = apiPost.getMockImplementation()!
    apiPost.mockImplementation(async (p: string, body: { entries: TimelineEvent[] }) => {
      if (body.entries.some((e) => e.id === 'poison')) throw new ApiError(422, 'Zeile zu gross')
      return good(p, body)
    })
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('ok1'))
    s.append(row('poison'))
    s.append(row('ok2'))
    await settle()
    await s.flush() // batch fails → single mode
    await s.flush() // ok1 accepted
    await s.flush() // poison alone → dead-lettered
    await s.flush() // ok2 accepted
    await settle()

    expect(s.pendingCount).toBe(0)
    expect(srv.rows.map((r) => r.row.id)).toEqual(['ok1', 'ok2'])
    expect(s.display().some((r) => r.id === 'poison')).toBe(true) // still visible locally
  })
})

describe('JournalStore — legacy blob rows', () => {
  it('queues legacy rows chronologically and keeps echoing them into the blob (never [])', async () => {
    fakeServer()
    const s = new JournalStore(INC, false)
    // blob timelines are newest-first: t2 is the newest
    await s.init([row('t2'), row('t1')])
    await settle(); await settle()

    // pushed oldest-first so server seqs preserve chronology
    expect(apiPost.mock.calls[0][1].entries.map((e: TimelineEvent) => e.id)).toEqual(['t1', 't2'])
    // the echo stays FOREVER: an empty timeline would merge as deletions and wipe the
    // Verlauf display on old-app devices still in the incident
    expect(s.blobTimeline().map((r) => r.id)).toEqual(['t2', 't1'])
    expect(s.display().map((r) => r.id)).toEqual(['t2', 't1'])
  })

  it('blobTimeline keeps a stable identity across journal appends (no save-loop retrigger)', async () => {
    fakeServer()
    const s = new JournalStore(INC, false)
    await s.init([row('t1')])
    const ref = s.blobTimeline()
    s.append(row('new'))
    await settle()
    expect(s.blobTimeline()).toBe(ref) // same reference → buildPayload memo doesn't re-fire
  })

  it('a viewer displays legacy rows but never queues, pushes, or persists', async () => {
    fakeServer()
    const s = new JournalStore(INC, true)
    await s.init([row('t1')])
    expect(s.display().map((r) => r.id)).toEqual(['t1'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(s.pendingCount).toBe(0)
  })

  it('a read-only (demoted) store never clobbers the editing tab’s persisted outbox', async () => {
    apiGet.mockRejectedValue(new ApiError(0, 'offline'))
    apiPost.mockRejectedValue(new ApiError(0, 'offline'))
    const editor = new JournalStore(INC, false)
    await editor.init([])
    editor.append(row('queued'))
    await settle(); await settle() // IDB put commits

    const demoted = new JournalStore(INC, true) // second tab, read-only
    await demoted.init([])
    await settle()

    const fresh = new JournalStore(INC, false) // “reload” of the editing tab
    await fresh.init([])
    expect(fresh.pendingCount).toBe(1) // the queued row survived the demoted tab
  })

  it('init merges the IDB snapshot — a row appended during the load window survives', async () => {
    apiGet.mockRejectedValue(new ApiError(0, 'offline'))
    apiPost.mockRejectedValue(new ApiError(0, 'offline'))
    const s = new JournalStore(INC, false)
    const initP = s.init([])
    s.append(row('early')) // lands while idbGet is in flight
    await initP
    await settle()
    expect(s.display().some((r) => r.id === 'early')).toBe(true)
    expect(s.pendingCount).toBe(1)
  })
})

describe('JournalStore — enrichment patches + session overlay', () => {
  it('folds transcript/media patches onto their target and hides the patch row', async () => {
    fakeServer()
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('a', { kind: 'audio' }))
    s.appendPatch('a', { transcript: 'Hallo' })
    s.appendPatch('a', { audioUrl: '/api/media/123' })
    await settle(); await settle()

    const d = s.display()
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ id: 'a', transcript: 'Hallo', audioUrl: '/api/media/123' })
  })

  it('a textEdit patch corrects the target text (rows stay append-only)', async () => {
    fakeServer()
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('a', { text: 'Trupp 1 an Font' }))
    s.appendPatch('a', { textEdit: 'Trupp 1 an Front' })
    await settle(); await settle()

    const d = s.display()
    expect(d).toHaveLength(1)
    expect(d[0].text).toBe('Trupp 1 an Front')
    // an empty correction is a no-op, never a blanked row
    s.appendPatch('a', { textEdit: undefined })
    await settle(); await settle()
    expect(s.display()[0].text).toBe('Trupp 1 an Front')
  })

  it('a retraction patch folds the row out of display; a later un-retract restores it', async () => {
    fakeServer()
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('a', { text: 'versehentlich übernommen' }))
    s.appendPatch('a', { retracted: true })
    await settle(); await settle()
    expect(s.display().some((r) => r.id === 'a')).toBe(false)
    // undo: a later patch wins (append-only lifecycle, nothing destroyed)
    s.appendPatch('a', { retracted: false })
    await settle(); await settle()
    expect(s.display().some((r) => r.id === 'a')).toBe(true)
  })

  it('clearing a transcript persists as "" (undefined would vanish in JSON and un-apply)', async () => {
    fakeServer()
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('a', { transcript: 'alt' }))
    s.appendPatch('a', { transcript: undefined })
    await settle(); await settle()

    const sentPatch = apiPost.mock.calls.flatMap((c) => c[1].entries).find((e: TimelineEvent) => e.patchOf === 'a')
    expect(sentPatch.transcript).toBe('')
    expect(s.display()[0].transcript).toBe('')
  })

  it('blob: URLs never persist — stripped from the stored row, shown via the overlay', async () => {
    fakeServer()
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('a', { kind: 'photo', photoUrl: 'blob:session-123' }))
    await settle(); await settle()

    const sent = apiPost.mock.calls[0][1].entries[0]
    expect(sent.photoUrl).toBeUndefined()
    expect(s.display()[0].photoUrl).toBe('blob:session-123')
  })

  it('flushKeepalive beacons the pending outbox at teardown', async () => {
    apiGet.mockRejectedValue(new ApiError(0, 'offline'))
    apiPost.mockRejectedValue(new ApiError(0, 'offline'))
    const s = new JournalStore(INC, false)
    await s.init([])
    s.append(row('a'))
    await settle()
    s.flushKeepalive()
    expect(apiBeacon).toHaveBeenCalledWith(`/api/incidents/${INC}/journal`, { entries: [expect.objectContaining({ id: 'a' })] })
  })

  it('survives a reload: outbox + rows come back from IndexedDB', async () => {
    apiGet.mockRejectedValue(new ApiError(0, 'offline'))
    apiPost.mockRejectedValue(new ApiError(0, 'offline'))
    const first = new JournalStore(INC, false)
    await first.init([])
    first.append(row('a'))
    await settle(); await settle()

    const second = new JournalStore(INC, false)
    await second.init([])
    expect(second.display().map((r) => r.id)).toEqual(['a'])
    expect(second.pendingCount).toBe(1)
  })
})
