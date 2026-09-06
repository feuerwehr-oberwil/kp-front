import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import * as idb from './idb'
import { AuditEventStore, type PendingAuditEvent } from './auditEventStore'

const { ingestEvents, ingestEventsBeacon } = vi.hoisted(() => ({ ingestEvents: vi.fn(), ingestEventsBeacon: vi.fn() }))
vi.mock('./api/events', () => ({ ingestEvents, ingestEventsBeacon }))

const stores: AuditEventStore[] = []
function open(owner = 'editor', readOnly = false) {
  const store = new AuditEventStore('incident', owner, readOnly)
  stores.push(store)
  store.start()
  return store
}
const event = (id: string, op_type = 'draw.add'): PendingAuditEvent => ({ client_id: id, op_type, payload: { id }, occurred_at: '2026-09-06T00:00:00Z' })

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  idb.__resetIdbForTests()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  ingestEvents.mockReset().mockRejectedValue(new ApiError(0, 'offline'))
  ingestEventsBeacon.mockReset()
})
afterEach(() => {
  stores.splice(0).forEach((store) => store.stop())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('AuditEventStore', () => {
  it('unions an immediate local event with delayed cache hydration before writing or posting', async () => {
    let release!: (value: { pending: PendingAuditEvent[]; rejected: PendingAuditEvent[] }) => void
    const hydration = new Promise<{ pending: PendingAuditEvent[]; rejected: PendingAuditEvent[] }>((resolve) => { release = resolve })
    vi.spyOn(idb, 'idbGet').mockReturnValueOnce(hydration)
    const write = vi.spyOn(idb, 'idbSet')
    const store = open()
    store.append(event('new-edit'))
    const flushing = store.flush()
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()
    expect(ingestEvents).not.toHaveBeenCalled()
    release({ pending: [event('older-offline-edit')], rejected: [] })
    await flushing
    expect(ingestEvents).toHaveBeenCalledWith('incident', [event('older-offline-edit'), event('new-edit')])
    expect(await idb.idbGet('kp-audit-incident:editor')).toMatchObject({ pending: [event('older-offline-edit'), event('new-edit')] })
  })

  it('persists before sending, and retries an accepted-but-unacknowledged event with its original ID', async () => {
    const accepted = new Set<string>()
    let loseResponse = true
    ingestEvents.mockImplementation(async (_id: string, events: PendingAuditEvent[]) => {
      expect(await idb.idbGet('kp-audit-incident:editor')).toMatchObject({ pending: events })
      events.forEach((e) => accepted.add(e.client_id))
      if (loseResponse) throw new ApiError(0, 'response lost')
    })
    const first = open()
    first.append(event('audit-one'))
    await first.flush()
    expect(first.status).toBe('offline')
    first.flushKeepalive()
    expect(first.pendingCount).toBe(1)
    first.stop()
    loseResponse = false
    const reopened = open()
    await reopened.flush()
    expect(ingestEvents.mock.calls.map((call) => call[1])).toEqual([[event('audit-one')], [event('audit-one')]])
    expect(accepted.size).toBe(1)
    expect(reopened.status).toBe('synced')
  })

  it('keeps events appended during an in-flight POST and persists the next batch before sending it', async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const response = new Promise<void>((resolve) => { release = resolve })
    ingestEvents.mockImplementationOnce(async () => { entered(); await response }).mockResolvedValue([])
    const store = open()
    store.append(event('first-edit'))
    const flushing = store.flush()
    await started
    store.append(event('second-edit'))
    release()
    await flushing
    expect(ingestEvents.mock.calls.map((call) => call[1])).toEqual([[event('first-edit')], [event('second-edit')]])
    expect(store.pendingCount).toBe(0)
    expect(await idb.idbGet('kp-audit-incident:editor')).toMatchObject({ pending: [] })
  })

  it('keeps an event too large for a teardown beacon instead of clearing it', async () => {
    const store = open()
    store.append({ ...event('large-event'), payload: { text: 'ä'.repeat(30_000) } })
    await store.flush()
    store.flushKeepalive()
    expect(ingestEventsBeacon).not.toHaveBeenCalled()
    expect(store.pendingCount).toBe(1)
  })

  it('retains more than 1000 offline events and drains them in bounded batches', async () => {
    const store = open()
    for (let n = 0; n < 1001; n++) store.append(event(`audit-${n}`))
    await store.flush()
    expect(store.pendingCount).toBe(1001)
    ingestEvents.mockClear().mockResolvedValue([])
    await store.flush()
    const sent: PendingAuditEvent[][] = ingestEvents.mock.calls.map((call) => call[1])
    expect(Math.max(...sent.map((batch) => batch.length))).toBeLessThanOrEqual(100)
    expect(new Set(sent.flat().map((e) => e.client_id)).size).toBe(1001)
    expect(store.pendingCount).toBe(0)
  })

  it('reports a refused durable write and clears the warning only once work reaches durable storage or server', async () => {
    const write = vi.spyOn(idb, 'idbSet').mockResolvedValue(false)
    const store = open()
    store.append(event('audit-one'))
    await store.flush()
    expect(store.cacheDurable).toBe(false)
    expect(store.status).toBe('storage')
    expect(store.pendingCount).toBe(1)
    write.mockRestore()
    ingestEvents.mockResolvedValue([])
    await store.flush()
    expect(store.status).toBe('synced')
    expect(store.cacheDurable).toBe(true)
  })

  it('keeps a rejected event visibly retained while valid events behind it reach the server', async () => {
    ingestEvents.mockImplementation(async (_id: string, events: PendingAuditEvent[]) => {
      if (events.some((e) => e.op_type === 'bad')) throw new ApiError(422, 'invalid')
    })
    const store = open()
    store.append(event('bad-event', 'bad'))
    store.append(event('good-event'))
    await store.flush()
    expect(store.pendingCount).toBe(0)
    expect(store.rejectedCount).toBe(1)
    expect(store.status).toBe('error')
    store.stop()
    ingestEvents.mockClear()
    const reopened = open()
    await reopened.flush()
    expect(reopened.rejectedCount).toBe(1)
    expect(ingestEvents).not.toHaveBeenCalled()
    expect(reopened.getRecoveryData().rejected).toEqual([event('bad-event', 'bad')])
    ingestEvents.mockResolvedValue([])
    await reopened.retry()
    expect(ingestEvents).toHaveBeenCalledWith('incident', [event('bad-event', 'bad')])
    expect(reopened.rejectedCount).toBe(0)
    expect(reopened.status).toBe('synced')
  })

  it('never drains a previous actor’s pending events under another login', async () => {
    const first = open('first-editor')
    first.append(event('first-edit'))
    await first.flush()
    first.stop()
    ingestEvents.mockClear().mockResolvedValue([])
    const other = open('second-editor')
    await other.flush()
    expect(ingestEvents).not.toHaveBeenCalled()
    expect(other.pendingCount).toBe(0)
    const original = open('first-editor')
    await original.flush()
    expect(ingestEvents).toHaveBeenCalledWith('incident', [event('first-edit')])
  })

  it('starts the last durable transaction before immediate writer demotion', async () => {
    const first = open()
    await first.flush() // cache hydration has completed before the operator edits
    first.append(event('last-edit-before-handover'))
    first.setReadOnly(true) // no microtask between edit and losing the tab lock
    const next = open()
    await next.flush()
    expect(next.getRecoveryData().pending).toEqual([event('last-edit-before-handover')])
  })

  it('exposes recoverable undurable work if ownership is lost before initial hydration answers', async () => {
    let release!: () => void
    const hydration = new Promise<null>((resolve) => { release = () => resolve(null) })
    vi.spyOn(idb, 'idbGet').mockReturnValueOnce(hydration)
    const write = vi.spyOn(idb, 'idbSet')
    const store = open()
    store.append(event('early-edit'))
    store.setReadOnly(true)
    release()
    await store.flush()
    expect(write).not.toHaveBeenCalled() // cannot overwrite the new owner's cache
    expect(store.status).toBe('storage')
    expect(store.getRecoveryData().pending).toEqual([event('early-edit')])
  })

  it('a read-only tab writes nothing, then reloads its predecessor’s pending work on promotion', async () => {
    const first = open()
    first.append(event('first-edit'))
    await first.flush()
    const write = vi.spyOn(idb, 'idbSet')
    const watcher = open('editor', true)
    await watcher.flush()
    watcher.append(event('forbidden'))
    watcher.flushKeepalive()
    expect(write).not.toHaveBeenCalled()
    first.append(event('later-edit'))
    await first.flush()
    first.setReadOnly(true)
    ingestEvents.mockClear().mockResolvedValue([])
    watcher.setReadOnly(false)
    await watcher.flush()
    expect(ingestEvents).toHaveBeenCalledWith('incident', [event('first-edit'), event('later-edit')])
  })
})
