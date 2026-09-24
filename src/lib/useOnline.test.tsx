// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet, apiGetRaw, apiPut } from './api'
import { isOnline, onReachable, resetConnectivityForTests } from './connectivity'
import { useOnline } from './useOnline'

// The «Offline» hint used to trust only the browser's `online`/`offline` events — and those are
// missed exactly when it matters (a WLAN up but routing nowhere, a backend restart, a reload while
// offline; e2e «offline journal entries survive reload and reconnect», 24.09.2026). Now any fresh
// successful answer from our server says «reachable», while a failure still never says «offline».

const fetchMock = vi.fn()
const ok = (body: unknown = {}, status = 200) =>
  new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  resetConnectivityForTests(true)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const goOffline = () => act(() => { window.dispatchEvent(new Event('offline')) })

describe('useOnline', () => {
  it('recovers on a successful fetch after the `online` event was missed', async () => {
    const { result } = renderHook(() => useOnline())
    goOffline()
    expect(result.current).toBe(false)
    fetchMock.mockResolvedValueOnce(ok({ entries: [] }))
    await act(async () => { await apiGet('/api/incidents/i1/journal') })
    expect(result.current).toBe(true) // no `online` event was ever dispatched
  })

  it('a successful sync (the PUT, the live-follow 304) counts as an answer', async () => {
    goOffline()
    fetchMock.mockResolvedValueOnce(ok({ workspace_rev: 8 }))
    await apiPut('/api/incidents/i1/workspace', { workspace: {}, base_rev: 7 })
    expect(isOnline()).toBe(true)
    goOffline()
    fetchMock.mockResolvedValueOnce(ok(null, 304))
    await apiGetRaw('/api/incidents/i1/workspace?since=8&wait=1')
    expect(isOnline()).toBe(true)
  })

  it('a service-worker-cached answer proves nothing about reach today', async () => {
    goOffline()
    fetchMock.mockResolvedValueOnce(ok({ bindings: [] }))
    await apiGet('/api/reference/obj1/alignments')
    expect(isOnline()).toBe(false)
  })

  it('a failed request never says «offline» by itself — it does not flap', async () => {
    const { result } = renderHook(() => useOnline())
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await act(async () => { await apiGet('/api/incidents').catch(() => {}) })
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }))
    await act(async () => { await apiGet('/api/incidents').catch(() => {}) })
    expect(result.current).toBe(true)
  })

  it('the `online` / `offline` events still drive it as before', () => {
    const { result } = renderHook(() => useOnline())
    goOffline()
    expect(result.current).toBe(false)
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(result.current).toBe(true)
  })
})

describe('onReachable — the outboxes\' «the server answers again»', () => {
  it('fires once on the first answer after a failure, not on every answer', async () => {
    const heard = vi.fn()
    const off = onReachable(heard)
    fetchMock.mockImplementation(async () => ok())
    await apiGet('/api/incidents')
    expect(heard).not.toHaveBeenCalled() // nothing had failed
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await apiGet('/api/incidents').catch(() => {})
    await apiGet('/api/incidents')
    await apiGet('/api/incidents')
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })

  it('a backend restart (502 from the proxy) is a failure to reach; a missed `online` event too', async () => {
    const heard = vi.fn()
    const off = onReachable(heard)
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    await apiGet('/api/incidents').catch(() => {})
    fetchMock.mockResolvedValueOnce(ok())
    await apiGet('/api/incidents')
    expect(heard).toHaveBeenCalledTimes(1)
    goOffline()
    fetchMock.mockResolvedValueOnce(ok())
    await apiGet('/api/incidents')
    expect(heard).toHaveBeenCalledTimes(2)
    off()
  })

  it('a request the CALLER dropped says nothing about the network', async () => {
    const heard = vi.fn()
    const off = onReachable(heard)
    const ctrl = new AbortController()
    fetchMock.mockImplementationOnce(() => { ctrl.abort(); return Promise.reject(new DOMException('aborted', 'AbortError')) })
    await apiGetRaw('/api/incidents/i1/workspace?wait=1', { signal: ctrl.signal }).catch(() => {})
    fetchMock.mockResolvedValueOnce(ok())
    await apiGet('/api/incidents')
    expect(heard).not.toHaveBeenCalled()
    off()
  })
})
