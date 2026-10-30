import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import * as idb from './idb'
import { AuditEventStore, type PendingAuditEvent } from './auditEventStore'
import { eventScopeFor, type EventScope } from './eventScope'
import { onIncidentClosed } from './incidentClosed'

const { ingestEvents, ingestEventsBeacon } = vi.hoisted(() => ({ ingestEvents: vi.fn(), ingestEventsBeacon: vi.fn() }))
vi.mock('./api/events', () => ({ ingestEvents, ingestEventsBeacon }))

const stores: AuditEventStore[] = []
function open(owner = 'editor', readOnly = false, scope?: EventScope) {
  const store = new AuditEventStore('incident', owner, readOnly, scope)
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
  vi.useRealTimers()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('audit outbox recovery and lifecycle', () => {
  it('does not accept or deliver events before write ownership starts', async () => {
    const store = new AuditEventStore('incident', 'editor', false)
    stores.push(store)
    expect(store.status).toBe('synced')
    store.append(event('unowned'))
    await store.flush()
    expect(store.pendingCount).toBe(0)
    expect(ingestEvents).not.toHaveBeenCalled()
    expect(store.getRecoveryData().pending).toEqual([])
  })

  it('keeps parked, rejected and pending identities in separate recovery buckets after hydration', async () => {
    await idb.idbSet('kp-audit-incident:editor', {
      pending: [event('rejected'), event('refused'), event('closed'), event('pending')],
      rejected: [event('rejected'), event('refused'), event('closed')],
      refused: [event('refused')], closed: [event('closed')],
    })
    const store = open('editor', true)
    await store.flush()
    expect(store.getRecoveryData()).toEqual({
      incidentId: 'incident', ownerId: 'editor', pending: [event('pending')], rejected: [event('rejected')],
      refused: [event('refused')], closed: [event('closed')],
    })
    await store.retry()
    await store.requeueClosed()
    store.flushKeepalive()
    store.append(event('read-only'))
    expect(store.pendingCount).toBe(1)
    expect(store.closedCount).toBe(1)
    expect(ingestEvents).not.toHaveBeenCalled()
    expect(ingestEventsBeacon).not.toHaveBeenCalled()
  })

  it('reclassifies rejected events on a role change, preserves earlier refused entries, and notifies', async () => {
    await idb.idbSet('kp-audit-incident:editor', {
      pending: [], rejected: [event('alarm', 'atemschutz.alarm'), event('record', 'journal.add')], refused: [event('earlier')],
    })
    const store = open()
    await store.flush()
    const seen = vi.fn()
    const off = store.subscribe(seen)
    store.setScope(eventScopeFor({ role: 'el' }))
    expect(store.getRecoveryData().refused).toEqual([event('earlier'), event('alarm', 'atemschutz.alarm')])
    expect(store.getRecoveryData().rejected).toEqual([event('record', 'journal.add')])
    expect(seen).toHaveBeenCalled()
    await vi.waitFor(async () => expect((await idb.idbGet<{ refused: PendingAuditEvent[] }>('kp-audit-incident:editor'))?.refused).toHaveLength(2))
    off()
  })

  it('does not let a stale unsubscribe remove a replacement listener', async () => {
    const store = open()
    await store.flush()
    const old = vi.fn(), current = vi.fn()
    const oldOff = store.subscribe(old)
    const currentOff = store.subscribe(current)
    oldOff()
    store.append(event('a'))
    expect(old).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledTimes(1)
    currentOff()
    store.append(event('b'))
    expect(current).toHaveBeenCalledTimes(1)
  })

  it('beacons at most 100 events without acknowledging or mutating the outbox', async () => {
    const store = open()
    await store.flush()
    for (let i = 0; i < 101; i++) store.append(event(String(i)))
    store.flushKeepalive()
    expect(ingestEventsBeacon).toHaveBeenCalledExactlyOnceWith('incident', Array.from({ length: 100 }, (_, i) => event(String(i))))
    expect(store.pendingCount).toBe(101)
    const exported = store.getRecoveryData()
    exported.pending[0].payload!.id = 'edited export'
    expect(store.getRecoveryData().pending[0]).toEqual(event('0'))
  })

  it('bounds teardown payloads by UTF-8 bytes while keeping the rest recoverable', async () => {
    const store = open()
    await store.flush()
    const large = { ...event('large'), payload: { text: 'ü'.repeat(13_000) } }
    store.append(large)
    store.append({ ...large, client_id: 'second' })
    store.flushKeepalive()
    expect(ingestEventsBeacon).toHaveBeenCalledExactlyOnceWith('incident', [large])
    expect(store.pendingCount).toBe(2)
  })

  it.each(['stop', 'demote'] as const)('ignores a late acknowledgement after %s and retains the original event', async (change) => {
    const store = open()
    await store.flush()
    let acknowledge!: () => void
    ingestEvents.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve }))
    store.append(event('late'))
    const flushing = store.flush()
    await vi.waitFor(() => expect(ingestEvents).toHaveBeenCalledTimes(1))
    if (change === 'stop') store.stop()
    else store.setReadOnly(true)
    acknowledge()
    await flushing
    store.append(event('forbidden'))
    expect(store.getRecoveryData().pending).toEqual([event('late')])
  })

  it.each([new ApiError(500, 'server'), new Error('network failed')])('retains retryable failures as an error instead of a rejection (%s)', async (error) => {
    ingestEvents.mockRejectedValue(error)
    const store = open()
    store.append(event('retry'))
    await store.flush()
    expect(store.status).toBe('error')
    expect(store.getRecoveryData().pending).toEqual([event('retry')])
    expect(store.rejectedCount).toBe(0)
  })

  it.each(['stop', 'demote'] as const)('ignores a late validation failure after %s', async (change) => {
    const store = open()
    await store.flush()
    let refuse!: (error: Error) => void
    ingestEvents.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = reject }))
    store.append(event('late-refusal'))
    const flushing = store.flush()
    await vi.waitFor(() => expect(ingestEvents).toHaveBeenCalledTimes(1))
    if (change === 'stop') store.stop()
    else store.setReadOnly(true)
    refuse(new ApiError(422, 'invalid'))
    await flushing
    expect(store.rejectedCount).toBe(0)
    expect(store.getRecoveryData().pending).toEqual([event('late-refusal')])
  })

  it('automatically sends after four seconds and retries an unreachable server after eight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = open()
    await store.flush()
    store.append(event('automatic'))
    await vi.advanceTimersByTimeAsync(3999)
    expect(ingestEvents).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(ingestEvents).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(8000)
    await vi.waitFor(() => expect(ingestEvents).toHaveBeenCalledTimes(2))
    store.stop()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(ingestEvents).toHaveBeenCalledTimes(2)
  })
})

describe('AuditEventStore', () => {
  // ⚠️ A failed IndexedDB read is not an empty outbox (23.09.2026) — see AuditEventStore · load.
  it('a failed outbox read writes nothing over the predecessor’s events, and merges them once a re-read answers', async () => {
    await idb.idbSet('kp-audit-incident:editor', { pending: [event('predecessor')], rejected: [] })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    vi.spyOn(idb, 'idbRead').mockResolvedValueOnce({ ok: false, error: new Error('io') })
    const write = vi.spyOn(idb, 'idbSet')
    const store = open()
    store.append(event('mine'))
    await store.flush()
    expect(write).not.toHaveBeenCalled()
    expect(store.status).toBe('storage')

    await vi.advanceTimersByTimeAsync(8_000)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 0))
    expect(await idb.idbGet('kp-audit-incident:editor')).toMatchObject({ pending: [event('predecessor'), event('mine')] })
    expect(store.status).toBe('offline')
  })

  it('a stop → start after a failed outbox read reads again, rather than keeping the failed read', async () => {
    await idb.idbSet('kp-audit-incident:editor', { pending: [event('predecessor')], rejected: [] })
    const read = vi.spyOn(idb, 'idbRead').mockResolvedValueOnce({ ok: false, error: new Error('io') })
    const store = open()
    await store.flush()
    expect(store.status).toBe('storage')
    // StrictMode's remount: stop() clears the re-read timer, start() must arm a fresh read
    store.stop()
    store.start()
    await store.flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(store.pendingCount).toBe(1)
    expect(store.status).toBe('offline')
  })

  it('unions an immediate local event with delayed cache hydration before writing or posting', async () => {
    let release!: (value: { pending: PendingAuditEvent[]; rejected: PendingAuditEvent[] }) => void
    const hydration = new Promise<{ pending: PendingAuditEvent[]; rejected: PendingAuditEvent[] }>((resolve) => { release = resolve })
    vi.spyOn(idb, 'idbRead').mockReturnValueOnce(hydration.then((value) => ({ ok: true as const, value })))
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
    vi.spyOn(idb, 'idbRead').mockReturnValueOnce(hydration.then((value) => ({ ok: true as const, value })))
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

// Post-mortem 23.09.2026, D6: the `el` phone ran the alarm engine like every device, its five
// `atemschutz.alarm` events came back 403, and the outbox held the shared sync status red for the
// rest of the Einsatz — «Erneut versuchen» re-sent them into the same 403.
describe('AuditEventStore · a 403 the role can never avoid is parked, not held red', () => {
  const el = eventScopeFor({ role: 'el' })
  const alarm = (id: string) => event(id, 'atemschutz.alarm')

  it('never queues an op the role cannot write', async () => {
    ingestEvents.mockResolvedValue([])
    const store = open('el-phone', false, el)
    store.append(alarm('az-1'))
    store.append(event('weather-1', 'weather.observe'))
    expect(store.pendingCount).toBe(1)
    await store.flush()
    expect(ingestEvents).toHaveBeenCalledWith('incident', [event('weather-1', 'weather.observe')])
    expect(store.status).toBe('synced')
  })

  it('an already-queued refused event (an older build’s outbox) lands in `refused`: synced, exportable, never re-sent', async () => {
    await idb.idbSet('kp-audit-incident:el-phone', { pending: [alarm('az-1'), event('att-1', 'attendance.set')], rejected: [] })
    ingestEvents.mockImplementation(async (_id: string, events: PendingAuditEvent[]) => {
      if (events.some((e) => e.op_type.startsWith('atemschutz.'))) throw new ApiError(403, 'denied')
      return []
    })
    const store = open('el-phone', false, el)
    await store.flush()
    expect(store.pendingCount).toBe(0)
    expect(store.rejectedCount).toBe(0)
    expect(store.refusedCount).toBe(1)
    expect(store.status).toBe('synced')
    expect(store.getRecoveryData()).toMatchObject({ refused: [alarm('az-1')] })
    ingestEvents.mockClear()
    await store.retry()
    expect(ingestEvents).not.toHaveBeenCalled()
    expect(store.refusedCount).toBe(1)
    // …and it survives a reload with the rest of the outbox
    store.stop()
    const reopened = open('el-phone', false, el)
    await reopened.flush()
    expect(reopened.refusedCount).toBe(1)
    expect(reopened.status).toBe('synced')
  })

  it('the cache the el phone carried out of 23.09. (five `rejected` alarms) goes quiet on the next open', async () => {
    const five = [1, 2, 3, 4, 5].map((n) => alarm(`az-${n}`))
    await idb.idbSet('kp-audit-incident:el-phone', { pending: [], rejected: five })
    const store = open('el-phone', false, el)
    await store.flush()
    expect(store.rejectedCount).toBe(0)
    expect(store.refusedCount).toBe(5)
    expect(store.status).toBe('synced')
    expect(await idb.idbGet('kp-audit-incident:el-phone')).toMatchObject({ refused: five, rejected: [] })
  })

  // N3
  it('what a CLOSED Einsatz refuses is parked for an editor too — the record events still land', async () => {
    const heard: unknown[] = []
    const off = onIncidentClosed((s) => heard.push(s))
    const closed = new ApiError(409, 'Einsatz ist abgeschlossen – nicht mehr übernommen')
    closed.code = 'incident_closed'
    closed.data = { code: 'incident_closed', closed_at: '2026-09-25T12:45:00Z' }
    ingestEvents.mockImplementation(async (_id: string, events: PendingAuditEvent[]) => {
      if (events.some((e) => e.op_type.startsWith('atemschutz.'))) throw closed
      return []
    })
    const store = open('editor', false, () => true)
    store.append(event('kontakt', 'atemschutz.contact'))
    store.append(event('rapport', 'report.edit'))
    store.append(alarm('az-2'))
    await store.flush()
    expect(ingestEvents).toHaveBeenCalledWith('incident', [event('rapport', 'report.edit')])
    expect(store.pendingCount).toBe(0)
    expect(store.rejectedCount).toBe(0)
    expect(store.refusedCount).toBe(0) // not a ROLE refusal — its own bucket, owed again on a reopen
    expect(store.closedCount).toBe(2)
    expect(store.status).toBe('synced')
    expect(heard).toContainEqual({ incidentId: 'incident', closedAt: '2026-09-25T12:45:00Z', source: 'refusal' })
    ingestEvents.mockClear()
    await store.retry()
    expect(ingestEvents).not.toHaveBeenCalled()
    // …until the Einsatz runs again: then they are owed, and go out
    ingestEvents.mockResolvedValue([])
    await store.requeueClosed()
    expect(ingestEvents.mock.calls.flatMap((c) => c[1]).map((e: PendingAuditEvent) => e.client_id).sort()).toEqual(['az-2', 'kontakt'].sort())
    expect(store.closedCount).toBe(0)
    off()
  })

  it('a 403 for an op the role SHOULD be able to write stays a visible error', async () => {
    ingestEvents.mockRejectedValue(new ApiError(403, 'denied'))
    const store = open('el-phone', false, el)
    store.append(event('att-1', 'attendance.set'))
    await store.flush()
    expect(store.rejectedCount).toBe(1)
    expect(store.refusedCount).toBe(0)
    expect(store.status).toBe('error')
  })

  it('an undurable cache holding a parked event is still the storage warning', async () => {
    vi.spyOn(idb, 'idbSet').mockResolvedValue(false)
    ingestEvents.mockRejectedValue(new ApiError(403, 'denied'))
    const editor = open('editor', false, () => true)
    editor.append(alarm('az-1'))
    await editor.flush()
    expect(editor.rejectedCount).toBe(1) // an editor may write it: a 403 here is a real mismatch
    editor.setScope(el)                  // the login was demoted to `el` under the open store
    expect(editor.rejectedCount).toBe(0)
    expect(editor.refusedCount).toBe(1)
    expect(editor.status).toBe('storage')
  })
  // #209's failure mode (a) for the audit outbox: the `online` handler / the reach signal
  // arrived while the POST sent before the reconnect was still settling, joined it, and the
  // events then waited for the next RETRY_MS tick although the link was back.
  it('a flush asked for while a failing POST is in flight gets its own attempt', async () => {
    const store = open()
    await store.flush() // hydrated, nothing to send
    let failInFlight!: () => void
    ingestEvents.mockImplementationOnce(() => new Promise((_, reject) => { failInFlight = () => reject(new ApiError(0, 'offline')) }))
    store.append(event('a'))
    const doomed = store.flush()
    await vi.waitFor(() => expect(ingestEvents).toHaveBeenCalledTimes(1))
    ingestEvents.mockResolvedValue(undefined) // the link is back…
    const reconnect = store.flush() // …and somebody asks again meanwhile
    failInFlight()
    await Promise.all([doomed, reconnect])
    expect(ingestEvents).toHaveBeenCalledTimes(2)
    expect(ingestEvents).toHaveBeenLastCalledWith('incident', [event('a')])
    expect(store.pendingCount).toBe(0)
    expect(store.status).toBe('synced')
  })

  it('a failed POST nobody asked to repeat is not repeated (an offline device does not spin)', async () => {
    const store = open()
    await store.flush()
    store.append(event('a'))
    await store.flush()
    expect(ingestEvents).toHaveBeenCalledTimes(1)
    await store.flush()
    expect(ingestEvents).toHaveBeenCalledTimes(2)
    expect(store.pendingCount).toBe(1)
    expect(store.status).toBe('offline')
  })
})
