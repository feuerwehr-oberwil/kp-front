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
