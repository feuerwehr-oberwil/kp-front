import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The gap between «Gespeichert» and the acknowledgement write (perf sweep 26.11.2026).
 *
 * When the server acknowledges the last queued row, JournalStore.syncStatus and
 * AuditEventStore.status read 'synced' at once – the IndexedDB write that records the
 * acknowledgement is still in flight. These tests hold that write forever (the app is killed
 * inside the gap: tab closed, iOS ends the PWA), re-hydrate a fresh store from what IndexedDB
 * holds, and pin what the restarted app does.
 */

const { apiGet, apiPost, apiBeacon, ingestEvents, ingestEventsBeacon } = vi.hoisted(() => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiBeacon: vi.fn(), ingestEvents: vi.fn(), ingestEventsBeacon: vi.fn(),
}))
vi.mock('./deviceName', () => ({ deviceName: () => undefined }))
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, apiGet, apiPost, apiBeacon }
})
vi.mock('./api/events', () => ({ ingestEvents, ingestEventsBeacon }))

import { ApiError } from './api'
import * as idb from './idb'
import { JournalStore } from './journalStore'
import { AuditEventStore, type PendingAuditEvent } from './auditEventStore'
import type { TimelineEvent } from '../types'

const INC = 'inc-gap'
const row = (id: string, over: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id, t: '14:00', at: '2026-07-02T14:00:00Z', icon: 'flag', text: `Zeile ${id}`, ...over })
const settle = () => new Promise((r) => setTimeout(r, 0))
const offline = () => new ApiError(0, 'offline')

/** The journal server: idempotent on the row id (backend/app/api/journal.py · append_rows),
 *  answers only the rows it newly took, serves since_seq pages. */
function journalServer(initial: TimelineEvent[] = []) {
  const rows: { seq: number; row: TimelineEvent }[] = initial.map((r, i) => ({ seq: i + 1, row: r }))
  const post = async (_path: string, body: { entries: TimelineEvent[] }) => {
    const have = new Set(rows.map((r) => r.row.id))
    const accepted: typeof rows = []
    for (const e of body.entries) {
      if (have.has(e.id)) continue
      have.add(e.id)
      const entry = { seq: rows.length + 1, row: e }
      rows.push(entry)
      accepted.push(entry)
    }
    return { entries: accepted, latest_seq: rows.length }
  }
  const get = async (path: string) => {
    const since = Number(/since_seq=(\d+)/.exec(path)?.[1] ?? 0)
    const page = rows.filter((r) => r.seq > since)
    return { entries: page, latest_seq: page.length ? page[page.length - 1].seq : since }
  }
  /** back on the network (both endpoints answer) */
  const online = () => { apiPost.mockImplementation(post); apiGet.mockImplementation(get) }
  online()
  return { rows, post, get, online }
}

/** Every IndexedDB write from now on never lands – the page dies before the transaction
 *  commits. Restore it before the restart. */
const killWrites = () => vi.spyOn(idb, 'idbSet').mockImplementation(() => new Promise<boolean>(() => {}))

/** A gate that holds a request until `open()`. */
function gate() {
  let open!: () => void
  const shut = new Promise<void>((r) => { open = r })
  return { shut, open }
}

const stored = async () => {
  const read = await idb.idbRead<{ rows: { row: TimelineEvent }[]; outbox: TimelineEvent[]; latestSeq: number; refused?: TimelineEvent[] }>(`kp-journal-${INC}`)
  return read.ok ? read.value : null
}

type JournalSnapshot = { rows: { row: TimelineEvent }[]; outbox: TimelineEvent[]; latestSeq: number; dead?: TimelineEvent[]; refused?: TimelineEvent[] }

/** Append a row, let the snapshot that queues it land, then die inside the acknowledgement
 *  gap. Returns the status and counts the dead store showed, the last snapshot it handed to
 *  the write that never landed, and what IndexedDB holds. */
async function ackThenDie(append: (s: JournalStore) => void) {
  const store = new JournalStore(INC, false)
  const post = apiPost.getMockImplementation()!
  const writes = vi.spyOn(idb, 'idbSet')
  try {
    await store.init([])
    const held = gate()
    apiPost.mockImplementation(async (p: string, b: unknown) => { await held.shut; return post(p, b) })
    append(store)
    const flushed = store.flush()
    await vi.waitFor(async () => expect((await stored())?.outbox.length).toBeGreaterThan(0))
    writes.mockClear().mockImplementation(() => new Promise<boolean>(() => {}))
    held.open()
    await flushed
    await settle()
    const lost = writes.mock.lastCall?.[1] as JournalSnapshot | undefined
    return {
      statusInGap: store.syncStatus, pendingInGap: store.pendingCount, rejectedInGap: store.rejectedCount,
      lost, cache: await stored(),
    }
  } finally {
    store.dispose()
    writes.mockRestore()
    apiPost.mockImplementation(post)
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  idb.__resetIdbForTests()
  for (const m of [apiGet, apiPost, apiBeacon, ingestEvents, ingestEventsBeacon]) m.mockReset()
})
afterEach(() => { vi.restoreAllMocks() })

describe('JournalStore – killed between «Gespeichert» and the acknowledgement write', () => {
  it('says synced while the stored outbox still holds the acknowledged row', async () => {
    journalServer()
    const { statusInGap, lost, cache } = await ackThenDie((s) => s.append(row('m1')))
    expect(statusInGap).toBe('synced')
    // the write that never landed is the one that records the acknowledgement
    expect(lost?.outbox).toEqual([])
    expect(lost?.rows.map((r) => r.row.id)).toEqual(['m1'])
    expect(cache?.outbox.map((r) => r.id)).toEqual(['m1'])
    expect(cache?.rows).toEqual([])
  })

  it('restarted online: the pull takes the row back from the server – nothing re-sent, shown once', async () => {
    const server = journalServer()
    await ackThenDie((s) => s.append(row('m1')))
    apiPost.mockClear()
    const restarted = new JournalStore(INC, false)
    try {
      await restarted.init([])
      expect(apiPost).not.toHaveBeenCalled()
      expect(server.rows.map((r) => r.row.id)).toEqual(['m1'])
      expect(restarted.display().map((r) => r.id)).toEqual(['m1'])
      expect(restarted.unsentRowIds().size).toBe(0)
      expect(restarted.syncStatus).toBe('synced')
    } finally { restarted.dispose() }
  })

  it('restarted offline: the row shows once but as «nur auf diesem Gerät»; back online it is not duplicated', async () => {
    const server = journalServer()
    await ackThenDie((s) => s.append(row('m1')))
    apiGet.mockRejectedValue(offline())
    apiPost.mockRejectedValue(offline())
    const restarted = new JournalStore(INC, false)
    try {
      await restarted.init([])
      expect(restarted.display().map((r) => r.id)).toEqual(['m1'])
      expect([...restarted.unsentRowIds()]).toEqual(['m1'])
      expect(restarted.syncStatus).toBe('offline')

      server.online()
      await restarted.flush()
      await settle()
      expect(server.rows.map((r) => r.row.id)).toEqual(['m1']) // the replay is skipped by id
      expect(restarted.display().map((r) => r.id)).toEqual(['m1'])
      expect(restarted.syncStatus).toBe('synced')
    } finally { restarted.dispose() }
  })

  // The replay's answer holds only the rows the server NEWLY took – the replayed row is not in
  // it – and the flush drops the row from the outbox. The store keeps it on display, as sent,
  // until a pull holds it (journalStore · SentRow); before 27.11.2026 the Verlauf showed it nowhere.
  describe('restarted offline, back online for the POST but not the pull', () => {
    /** Restart offline, then replay the stored row with the POST answering and the pull failing.
     *  Asserts the scenario itself; returns the restarted store after the replay. */
    async function replayWithoutPull() {
      const server = journalServer()
      await ackThenDie((s) => s.append(row('m1')))
      apiGet.mockRejectedValue(offline())
      apiPost.mockRejectedValue(offline())
      const restarted = new JournalStore(INC, false)
      await restarted.init([])
      expect(restarted.display().map((r) => r.id)).toEqual(['m1'])
      apiPost.mockReset().mockImplementation(server.post)
      apiGet.mockClear()
      await restarted.flush()
      await settle()
      expect(apiPost).toHaveBeenCalledWith(`/api/incidents/${INC}/journal`, { entries: [expect.objectContaining({ id: 'm1' })] })
      const answer: unknown = await apiPost.mock.results[0]?.value
      expect(answer).toEqual({ entries: [], latest_seq: 1 }) // the replay is skipped by id
      expect(apiGet).toHaveBeenCalled() // the drain's pull went out …
      await expect(apiGet.mock.results[0]?.value).rejects.toThrow() // … and failed
      expect(restarted.pendingCount).toBe(0)
      return restarted
    }

    it('the scenario: visible before the replay, replay skipped, pull failed', async () => {
      const restarted = await replayWithoutPull()
      restarted.dispose()
    })

    it('the row stays in the Verlauf, as sent', async () => {
      const restarted = await replayWithoutPull()
      try {
        expect(restarted.display().map((r) => r.id)).toEqual(['m1'])
        expect(restarted.unsentRowIds().size).toBe(0)
        expect(restarted.syncStatus).toBe('synced')
      } finally { restarted.dispose() }
    })

    it('restarted again before the pull: still shown, nothing re-sent; the pull shows it once', async () => {
      const restarted = await replayWithoutPull()
      await vi.waitFor(async () => expect((await stored())?.outbox).toEqual([]))
      restarted.dispose()
      apiPost.mockClear()
      const again = new JournalStore(INC, false)
      try {
        await again.init([])
        expect(again.display().map((r) => r.id)).toEqual(['m1'])
        expect(apiPost).not.toHaveBeenCalled()
        apiGet.mockImplementation(journalServer([row('m1')]).get)
        expect(await again.pull()).toBe('new')
        expect(again.display().map((r) => r.id)).toEqual(['m1'])
      } finally { again.dispose() }
    })
  })

  it('a row the closed Einsatz refused: the restart re-sends it, it is refused again and parked again', async () => {
    const server = journalServer()
    const closed = () => {
      const e = new ApiError(409, 'Einsatz ist abgeschlossen – nicht mehr übernommen')
      e.code = 'incident_closed'
      e.data = { code: 'incident_closed', closed_at: '2026-09-25T12:45:00Z' }
      return e
    }
    apiPost.mockImplementation(async (p: string, b: { entries: TimelineEvent[] }) => {
      if (b.entries.some((e) => e.kind === 'team')) throw closed()
      return server.post(p, b)
    })
    const { statusInGap, lost, cache } = await ackThenDie((s) => s.append(row('kontakt', { kind: 'team', at: '2026-09-25T12:50:00Z' })))
    expect(statusInGap).toBe('synced')
    expect(lost?.outbox).toEqual([])
    expect(lost?.refused?.map((r) => r.id)).toEqual(['kontakt'])
    expect(cache?.outbox.map((r) => r.id)).toEqual(['kontakt'])
    const restarted = new JournalStore(INC, false)
    try {
      await restarted.init([])
      expect(server.rows).toEqual([])
      expect(restarted.pendingCount).toBe(0)
      expect(restarted.refusedCount).toBe(1)
      expect(restarted.display()).toEqual([])
      expect(restarted.syncStatus).toBe('synced')
    } finally { restarted.dispose() }
  })

  it('a dead-lettered row has no gap: the status says pending until its write lands; the restart dead-letters it again', async () => {
    journalServer()
    apiPost.mockRejectedValue(new ApiError(422, 'refused'))
    const { statusInGap, pendingInGap, rejectedInGap, lost, cache } = await ackThenDie((s) => s.append(row('bad')))
    expect([pendingInGap, rejectedInGap]).toEqual([0, 1])
    expect(lost?.dead?.map((r) => r.id)).toEqual(['bad'])
    expect(statusInGap).toBe('pending')
    expect(cache?.outbox.map((r) => r.id)).toEqual(['bad'])
    apiPost.mockClear()
    const restarted = new JournalStore(INC, false)
    try {
      await restarted.init([])
      expect(apiPost).toHaveBeenCalledWith(`/api/incidents/${INC}/journal`, { entries: [expect.objectContaining({ id: 'bad' })] })
      expect(restarted.rejectedCount).toBe(1)
      await vi.waitFor(() => expect(restarted.syncStatus).toBe('error'))
      expect(restarted.display().map((r) => r.id)).toEqual(['bad'])
    } finally { restarted.dispose() }
  })

  it('rows pulled from another device: the cursor is not stored, the restart pulls them again once', async () => {
    const server = journalServer([row('a'), row('b')])
    const store = new JournalStore(INC, false)
    // the hydration's own write lands; the first pull's write never does
    const real = idb.idbSet
    let calls = 0
    const writes = vi.spyOn(idb, 'idbSet').mockImplementation((k, v) => (++calls === 1 ? real(k, v) : new Promise<boolean>(() => {})))
    try {
      await store.init([])
      await settle()
      expect(store.display().map((r) => r.id)).toEqual(['b', 'a'])
      expect(store.syncStatus).toBe('synced')
      expect((writes.mock.lastCall?.[1] as JournalSnapshot).latestSeq).toBe(2) // the write that never landed
      expect((await stored())?.latestSeq).toBe(0)
    } finally {
      store.dispose()
      writes.mockRestore()
    }

    apiGet.mockRejectedValue(offline())
    const offlineStart = new JournalStore(INC, false)
    try {
      await offlineStart.init([])
      // not this device's rows to keep: they are on the server and come back with the next pull
      expect(offlineStart.display()).toEqual([])
    } finally { offlineStart.dispose() }

    server.online()
    const restarted = new JournalStore(INC, false)
    try {
      await restarted.init([])
      expect(restarted.display().map((r) => r.id)).toEqual(['b', 'a'])
    } finally { restarted.dispose() }
  })
})

describe('AuditEventStore – killed between «Gespeichert» and the acknowledgement write', () => {
  const event = (id: string): PendingAuditEvent => ({ client_id: id, op_type: 'draw.add', payload: { id }, occurred_at: '2026-09-06T00:00:00Z' })
  const storedPending = async () => {
    const read = await idb.idbRead<{ pending: PendingAuditEvent[] }>('kp-audit-incident:editor')
    return read.ok ? read.value?.pending.map((e) => e.client_id) : undefined
  }

  it('says synced while the stored outbox still holds the event; the restart re-sends it under its client_id', async () => {
    // the server keeps one event per client_id (backend/app/audit.py · append_event)
    const chain = new Map<string, PendingAuditEvent>()
    const held = gate()
    ingestEvents.mockImplementation(async (_inc: string, batch: PendingAuditEvent[]) => {
      await held.shut
      for (const e of batch) if (!chain.has(e.client_id)) chain.set(e.client_id, e)
      return []
    })
    const store = new AuditEventStore('incident', 'editor', false)
    let writes: ReturnType<typeof killWrites> | undefined
    try {
      store.start()
      store.append(event('e1'))
      void store.flush()
      await vi.waitFor(() => expect(ingestEvents).toHaveBeenCalled())
      expect(await storedPending()).toEqual(['e1'])
      writes = killWrites()
      held.open()
      await vi.waitFor(() => expect(store.status).toBe('synced'))
      await settle()
      // the write that never landed is the one that empties the queue
      expect((writes.mock.lastCall?.[1] as { pending: PendingAuditEvent[] }).pending).toEqual([])
      expect(await storedPending()).toEqual(['e1'])
    } finally {
      store.stop()
      writes?.mockRestore()
    }

    ingestEvents.mockClear()
    const restarted = new AuditEventStore('incident', 'editor', false)
    restarted.start()
    try {
      await vi.waitFor(() => expect(ingestEvents).toHaveBeenCalled())
      expect(ingestEvents.mock.calls[0][1].map((e: PendingAuditEvent) => e.client_id)).toEqual(['e1'])
      await vi.waitFor(() => expect(restarted.status).toBe('synced'))
      expect([...chain.keys()]).toEqual(['e1'])
      await vi.waitFor(async () => expect(await storedPending()).toEqual([]))
    } finally { restarted.stop() }
  })
})
