// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetIdbForTests } from './idb'
import { ApiError } from './api'

const { ingestEvents, ingestEventsBeacon } = vi.hoisted(() => ({ ingestEvents: vi.fn(), ingestEventsBeacon: vi.fn() }))
vi.mock('./api/events', async () => ({
  ...await vi.importActual<typeof import('./api/events')>('./api/events'),
  ingestEvents, ingestEventsBeacon,
}))
import { useAuditEvents } from './useAuditEvents'
import { noteAnswered, noteUnreached, resetConnectivityForTests } from './connectivity'
import { eventScopeFor } from './eventScope'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  ingestEvents.mockReset().mockRejectedValue(new ApiError(0, 'offline'))
  ingestEventsBeacon.mockReset()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>

describe('durable audit capture', () => {
  it('recreates the pending event after offline teardown with the same client identity', async () => {
    const first = renderHook(() => useAuditEvents('incident', false, 'editor'), { wrapper })
    act(() => first.result.current.emit('draw.add', { id: 'drawing' }))
    await act(async () => { await first.result.current.flushEvents() })
    await waitFor(() => expect(ingestEvents).toHaveBeenCalledTimes(1))
    const original = ingestEvents.mock.calls[0][1][0]
    expect(original.client_id).toEqual(expect.any(String))
    act(() => first.result.current.flushEventsBeacon())
    first.unmount()
    ingestEvents.mockClear().mockResolvedValue([])
    const second = renderHook(() => useAuditEvents('incident', false, 'editor'), { wrapper })
    await act(async () => { await second.result.current.flushEvents() })
    await waitFor(() => expect(ingestEvents).toHaveBeenCalledWith('incident', [original]))
    second.unmount()
  })
})

describe('the server answers again without an `online` event', () => {
  it('the audit outbox goes out on the first answer after a failure to reach the server', async () => {
    resetConnectivityForTests(true)
    const hook = renderHook(() => useAuditEvents('incident', false, 'editor'))
    act(() => hook.result.current.emit('draw.add', { id: 'drawing' }))
    await act(async () => { await hook.result.current.flushEvents() })
    await waitFor(() => expect(hook.result.current.status).toBe('offline'))
    ingestEvents.mockClear().mockResolvedValue([])
    noteUnreached() // what the failed POST told the fetch wrapper
    act(() => { noteAnswered() }) // some other request got through — no `online` event
    await waitFor(() => expect(hook.result.current.status).toBe('synced'))
    expect(ingestEvents).toHaveBeenCalledTimes(1)
    hook.unmount()
  })
})

// Post-mortem 23.09.2026, D5 + D6: one login on three tablets recorded every Atemschutz alarm
// three times, and the `el` phone's copies 403'd into an outbox that stayed red.
describe('observed events and the role scope', () => {
  const actor = 'user-9ff239:login'
  const observed = { observed: 'azal-tr1-2026-09-23T17:36:14.228Z' }

  it('the same alarm on two devices of one login is the same client_id and the same payload', async () => {
    ingestEvents.mockResolvedValue([])
    const sent: { client_id: string; op_type: string; payload: unknown }[] = []
    for (const _device of ['ipad', 'android']) {
      globalThis.indexedDB = new IDBFactory() // a separate device: its own outbox
      __resetIdbForTests()
      ingestEvents.mockClear()
      const hook = renderHook(() => useAuditEvents('incident', false, actor), { wrapper })
      act(() => hook.result.current.emit('atemschutz.alarm', { id: 'tr1', status: 'ueberfaellig' }, observed))
      await act(async () => { await hook.result.current.flushEvents() })
      await waitFor(() => expect(ingestEvents).toHaveBeenCalledTimes(1))
      const [{ client_id, op_type, payload }] = ingestEvents.mock.calls[0][1]
      sent.push({ client_id, op_type, payload })
      hook.unmount()
    }
    const [a, b] = sent
    expect(a.client_id).toBe(b.client_id)
    expect(a.client_id).toMatch(/^obs-azal-tr1-/)
    expect(JSON.stringify(a.payload)).toBe(JSON.stringify(b.payload))
    expect(a.op_type).toBe(b.op_type)
  })

  it('a hand-performed event still gets a fresh id per emit', async () => {
    ingestEvents.mockResolvedValue([])
    const hook = renderHook(() => useAuditEvents('incident', false, actor), { wrapper })
    act(() => { hook.result.current.emit('draw.add', { id: 'd' }); hook.result.current.emit('draw.add', { id: 'd' }) })
    await act(async () => { await hook.result.current.flushEvents() })
    await waitFor(() => expect(ingestEvents).toHaveBeenCalled())
    const ids = ingestEvents.mock.calls.flatMap((c) => c[1].map((e: { client_id: string }) => e.client_id))
    expect(new Set(ids).size).toBe(2)
    hook.unmount()
  })

  it('an `el` session emits no atemschutz audit event at all — and stays synced', async () => {
    ingestEvents.mockResolvedValue([])
    const scope = eventScopeFor({ role: 'el' })
    const hook = renderHook(() => useAuditEvents('incident', false, 'el-user:login', scope), { wrapper })
    act(() => {
      hook.result.current.emit('atemschutz.alarm', { id: 'tr1', status: 'ueberfaellig' }, observed)
      hook.result.current.emit('atemschutz.alarm.cleared', { id: 'tr1' }, { observed: 'azcl-tr1-x' })
      hook.result.current.emit('attendance.set', { id: 'p1' })
    })
    await act(async () => { await hook.result.current.flushEvents() })
    await waitFor(() => expect(ingestEvents).toHaveBeenCalled())
    const ops = ingestEvents.mock.calls.flatMap((c) => c[1].map((e: { op_type: string }) => e.op_type))
    expect(ops).toEqual(['attendance.set'])
    await waitFor(() => expect(hook.result.current.status).toBe('synced'))
    expect(hook.result.current.refusedCount).toBe(0)
    hook.unmount()
  })
})
