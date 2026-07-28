import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiBeacon, apiDelete, apiGet, apiGetRaw, apiPost } from './api'

// api.ts is the fetch wrapper under EVERY backend call: typed errors, the transparent
// 401→refresh→retry, 429 Retry-After parsing, offline (status 0) detection, and empty-body
// handling. The auth gate and the WorkspaceSync engine both branch on these, so a regression
// here is silent and wide. We mock global fetch and assert the wrapper's behaviour.

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init })

describe('request — success & empty bodies', () => {
  it('parses a JSON body and sends cookies', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: 1 }))
    await expect(apiGet<{ ok: number }>('/api/x')).resolves.toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledWith('/api/x', expect.objectContaining({ credentials: 'include' }))
  })

  it('returns undefined for a 204 (no JSON parse attempted)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(apiDelete('/api/x')).resolves.toBeUndefined()
  })

  it('returns undefined for an explicitly empty body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200, headers: { 'Content-Length': '0' } }))
    await expect(apiGet('/api/x')).resolves.toBeUndefined()
  })
})

describe('request — error mapping', () => {
  it('maps a network/CORS failure to ApiError(0)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 0 })
  })

  it('uses the server-provided {detail} on a non-2xx JSON error', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'PIN gesperrt' }, { status: 403 }))
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 403, detail: 'PIN gesperrt' })
  })

  // A 502/504 comes from the reverse proxy as an HTML page, so there is no {detail} to show —
  // and statusText is an English protocol phrase, empty over HTTP/2. The screen used to end up
  // with a bare "HTTP 502", which names the plumbing and answers nothing.
  it('explains a proxy 502 instead of quoting the protocol at the operator', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }))
    await expect(apiGet('/api/x')).rejects.toMatchObject({
      status: 502,
      detail: 'Server nicht erreichbar',
      hint: expect.stringContaining('startet er gerade neu'),
    })
  })

  it('says the same for 503/504 — down or restarting is one situation to the operator', async () => {
    for (const status of [503, 504]) {
      fetchMock.mockResolvedValueOnce(new Response('', { status }))
      await expect(apiGet('/api/x')).rejects.toMatchObject({ status, detail: 'Server nicht erreichbar' })
    }
  })

  it('separates a 500 from a gateway error — waiting does not help there', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }))
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 500, detail: 'Fehler auf dem Server' })
  })

  it('names the common client statuses', async () => {
    const cases: [number, string][] = [[403, 'Keine Berechtigung'], [404, 'Vom Server nicht gefunden'], [413, 'Datei zu gross']]
    for (const [status, detail] of cases) {
      fetchMock.mockResolvedValueOnce(new Response('', { status }))
      await expect(apiGet('/api/x')).rejects.toMatchObject({ status, detail })
    }
  })

  // The backend speaks German and knows the actual situation — «PIN gesperrt» beats any
  // generic reading of a 403, and it must not be trailed by a hint that contradicts it.
  it("the server's own message still wins, and drops the generic hint", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'PIN gesperrt' }, { status: 403 }))
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 403, detail: 'PIN gesperrt', hint: undefined })
  })

  it('falls back to the bare status for something we have no reading of', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 399, statusText: '' }))
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 399, detail: 'HTTP 399' })
  })

  it('parses Retry-After (seconds) on a 429 cooldown', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'zu viele Versuche' }, { status: 429, headers: { 'Retry-After': '30' } }))
    await expect(apiPost('/api/auth/login', {})).rejects.toMatchObject({ status: 429, retryAfter: 30 })
  })

  it('ignores a non-numeric Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'nope' }, { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct' } }))
    const err = await apiGet('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(429)
    expect((err as ApiError).retryAfter).toBeUndefined()
  })
})

describe('request — transparent 401 refresh + retry', () => {
  it('refreshes once on a 401 (non-auth path) and retries the original request', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))   // original 401s
      .mockResolvedValueOnce(new Response(null, { status: 200 }))   // /api/auth/refresh ok
      .mockResolvedValueOnce(json({ ok: 1 }))                       // retry succeeds
    await expect(apiGet<{ ok: number }>('/api/incidents')).resolves.toEqual({ ok: 1 })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh')
  })

  it('does NOT refresh-loop on an auth-path 401 (failed login throws straight through)', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'falsche PIN' }, { status: 401 }))
    await expect(apiPost('/api/auth/login', {})).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1) // no /api/auth/refresh attempt
  })

  it('throws the 401 when the refresh itself fails (no infinite retry)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 })) // original
      .mockResolvedValueOnce(new Response(null, { status: 401 })) // refresh also 401 → ok=false
    await expect(apiGet('/api/incidents')).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(2) // original + refresh, no retry
  })

  it('single-flights concurrent 401s through ONE refresh call', async () => {
    let dataCalls = 0
    let refreshCalls = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') { refreshCalls++; return new Response(null, { status: 200 }) }
      dataCalls++
      // the two concurrent originals 401; their retries (after the shared refresh) succeed
      return dataCalls <= 2 ? new Response(null, { status: 401 }) : json({ ok: dataCalls })
    })

    const [a, b] = await Promise.all([apiGet('/api/a'), apiGet('/api/b')])
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(refreshCalls).toBe(1) // both 401s shared the in-flight refresh, not one each
  })
})

describe('request — timeouts (half-open connections)', () => {
  // The field failure mode is not a refused connection but a stalled one (dying AP, one bar of
  // LTE, captive portal). fetch has no default timeout, so without these the boot path hangs
  // forever behind a blank page / an actionless splash. Status MUST stay 0 so every existing
  // offline fallback (cached user, cached incident list, cached workspace) still triggers.
  it('arms an abort signal on a normal request', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: 1 }))
    await apiGet('/api/x')
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('maps its own timeout abort to ApiError(0) with the timeout wording', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    const err = await apiGet('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0) // offline fallbacks key off this
    expect((err as ApiError).detail).toMatch(/Zeitüberschreitung/)
  })

  it('carries a hint on the offline path too — cached Einsätze are still there', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(apiGet('/api/x')).rejects.toMatchObject({
      status: 0,
      hint: expect.stringContaining('offline verfügbar'),
    })
  })

  it('distinguishes a hard network failure from a timeout in the message', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const err = await apiGet('/api/x').catch((e: unknown) => e)
    expect((err as ApiError).detail).toMatch(/nicht erreichbar/)
  })

  it('leaves a keepalive beacon UNBOUNDED — its whole point is to outlive the page', () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    apiBeacon('/api/diag/client-error', { a: 1 })
    expect(fetchMock.mock.calls[0][1].signal).toBeUndefined()
  })
})

describe('apiGetRaw — caller-branched statuses', () => {
  it('returns the Response without throwing on a non-2xx (e.g. 304)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }))
    const res = await apiGetRaw('/api/incidents/x/workspace?since=4')
    expect(res.status).toBe(304)
  })

  it('still maps a network failure to ApiError(0)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await expect(apiGetRaw('/api/x')).rejects.toMatchObject({ status: 0 })
  })
})

describe('apiBeacon — fire-and-forget teardown', () => {
  it('issues a keepalive request and never throws, even when fetch rejects', () => {
    fetchMock.mockRejectedValueOnce(new TypeError('page gone'))
    expect(() => apiBeacon('/api/incidents/x/workspace', { a: 1 }, 'PUT')).not.toThrow()
    expect(fetchMock).toHaveBeenCalledWith('/api/incidents/x/workspace', expect.objectContaining({
      method: 'PUT', keepalive: true,
    }))
  })
})
