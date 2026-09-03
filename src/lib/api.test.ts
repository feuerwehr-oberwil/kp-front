import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, SESSION_EXPIRED_EVENT, apiBeacon, apiDelete, apiGet, apiGetRaw, apiPost, apiPut, isUnverifiable } from './api'
import { resetServerClock, serverClockOffsetMs } from './serverClock'

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

  // …and when the same answer carries a NAME, keep both halves. Two 403s on one route can mean
  // «diese Wehr hat die Funktion nie eingerichtet» (an instruction) and «dieses Konto darf das
  // nicht» (nothing to do); a screen keying on the status alone shows the wrong one half the time.
  it('reads a {code, message} detail as both, so a caller can tell two refusals apart', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ detail: { code: 'link_key_missing', message: 'Einsatz-Links deaktiviert' } }, { status: 403 }),
    )
    await expect(apiGet('/api/x')).rejects.toMatchObject({
      status: 403, detail: 'Einsatz-Links deaktiviert', code: 'link_key_missing', hint: undefined,
    })
  })

  it('leaves `code` unset for a plain string detail — nothing was named', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'PIN gesperrt' }, { status: 403 }))
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 403, code: undefined })
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

// FastAPI answers an invalid document with an ARRAY of validation items rather than a `{detail}`
// string, and that array is the only machine-readable account of what was wrong. Flattened it is
// English Pydantic prose («Input should be a valid list»), which is what a German-speaking
// volunteer was actually shown when a coordinate went in wrong – so the parsed pairs are kept as
// `ApiError.fields` and admin/ConfigContext · describeRejectedFields turns them into a sentence
// naming the field.
//
// ⚠️ That consumer is tested against a hand-built ApiError of its own (ConfigAutosave.test.tsx,
// ConfigBackup.test.tsx both define one in vi.hoisted()), so nothing there can notice if THIS
// parser stops producing the shape: rename `path` to `loc` and both suites stay green while the
// UI silently falls back to the raw English prose the whole feature exists to replace. These
// cases drive the real parser against a genuine FastAPI 422 body.
describe('request – the 422 validation array (ApiError.fields)', () => {
  /** Verbatim shape of a FastAPI/Pydantic v2 422 for a config PUT. */
  const validation422 = (items: unknown[]) => json({ detail: items }, { status: 422 })

  const badVehicleName = {
    type: 'string_type',
    loc: ['body', 'fleet', 'vehicles', 2, 'name'],
    msg: 'Input should be a valid string',
    input: { kurz: 'TLF 31' },
    url: 'https://errors.pydantic.dev/2.11/v/string_type',
  }
  const badLinks = {
    type: 'list_type',
    loc: ['body', 'report', 'links'],
    msg: 'Input should be a valid list',
    input: 'https://formulare.example.ch/rapport.pdf',
    url: 'https://errors.pydantic.dev/2.11/v/list_type',
  }

  it('parses each item into path / msg / kind / input', async () => {
    fetchMock.mockResolvedValueOnce(validation422([badVehicleName, badLinks]))
    const err = (await apiPut('/api/config', {}).catch((e: unknown) => e)) as ApiError
    expect(err.status).toBe(422)
    expect(err.fields).toEqual([
      {
        // 'body' dropped, the index KEPT – describeRejectedFields reads the last index to say
        // «Fahrzeuge, Eintrag 3», and a person counts entries, not JSON paths
        path: 'fleet.vehicles.2.name',
        msg: 'Input should be a valid string',
        kind: 'string_type',
        input: { kurz: 'TLF 31' },
      },
      { path: 'report.links', msg: 'Input should be a valid list', kind: 'list_type', input: 'https://formulare.example.ch/rapport.pdf' },
    ])
  })

  it('keeps `kind` and `input` – what was EXPECTED and what was actually there', async () => {
    fetchMock.mockResolvedValueOnce(validation422([badVehicleName]))
    const err = (await apiPut('/api/config', {}).catch((e: unknown) => e)) as ApiError
    // FastAPI's `type`/`input` under our names; the config import says both out loud because the
    // file is hand-edited and the shape is the whole question.
    expect(err.fields?.[0].kind).toBe('string_type')
    expect(err.fields?.[0].input).toEqual({ kurz: 'TLF 31' })
  })

  it('still flattens the array into a readable `detail`, and drops the generic hint', async () => {
    fetchMock.mockResolvedValueOnce(validation422([badVehicleName, badLinks]))
    const err = (await apiPut('/api/config', {}).catch((e: unknown) => e)) as ApiError
    expect(err.detail).toBe(
      'fleet.vehicles.2.name: Input should be a valid string · report.links: Input should be a valid list',
    )
    expect(err.hint).toBeUndefined()
  })

  it('survives an item with no loc and no msg rather than dropping the whole answer', async () => {
    fetchMock.mockResolvedValueOnce(validation422([{ type: 'value_error' }]))
    const err = (await apiPut('/api/config', {}).catch((e: unknown) => e)) as ApiError
    expect(err.fields).toEqual([{ path: '', msg: 'Ungültiger Wert', kind: 'value_error', input: undefined }])
    expect(err.detail).toBe('Ungültiger Wert') // no stray «: » prefix for a pathless item
  })

  it('leaves `fields` unset for a plain {detail} error – the German server message stands alone', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'Die Konfiguration wurde inzwischen geändert.' }, { status: 409 }))
    const err = (await apiPut('/api/config', {}).catch((e: unknown) => e)) as ApiError
    expect(err.fields).toBeUndefined()
    expect(err.detail).toBe('Die Konfiguration wurde inzwischen geändert.')
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

describe('isUnverifiable — silence vs. refusal', () => {
  // The boot fallbacks (cached user, cached incident list) used to key off status 0 alone, so
  // a Railway restart during a launch — a 502 from the proxy — bounced a logged-in tablet to
  // the PIN pad. To the operator «no answer» and «a gateway in front of a restarting server»
  // are the same situation; a 401 or a 500 is an answer.
  it('is true for status 0 and the three gateway statuses', () => {
    for (const status of [0, 502, 503, 504]) expect(isUnverifiable(new ApiError(status, 'x'))).toBe(true)
  })

  it('is false for a real refusal and for non-ApiErrors', () => {
    for (const status of [401, 403, 404, 500]) expect(isUnverifiable(new ApiError(status, 'x'))).toBe(false)
    expect(isUnverifiable(new Error('x'))).toBe(false)
  })
})

describe('request — a session that cannot be repaired', () => {
  // A failed refresh means every later request 401s the same way; api.ts says so ONCE on
  // `window`, and AuthProvider turns it into `sessionExpired`. The 401 still reaches the caller.
  it('dispatches kp:session-expired when the refresh is refused', async () => {
    const win = new EventTarget()
    const onExpired = vi.fn()
    win.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    vi.stubGlobal('window', win)
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 401 })) // the refresh
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 401 })
    expect(onExpired).toHaveBeenCalledOnce()
  })

  it('stays quiet when the refresh succeeds', async () => {
    const win = new EventTarget()
    const onExpired = vi.fn()
    win.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    vi.stubGlobal('window', win)
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 200 })) // the refresh
      .mockResolvedValueOnce(json({ ok: 1 }))
    await expect(apiGet('/api/x')).resolves.toEqual({ ok: 1 })
    expect(onExpired).not.toHaveBeenCalled()
  })
})

// Every /api/ answer carries the server's clock, and this wrapper is where the app learns it —
// so the Atemschutz board can count in the deployment's time instead of the device's (see
// lib/serverClock). It samples on ANY answer, error responses included.
describe('request — the server clock rides along', () => {
  afterEach(() => resetServerClock())

  it('learns the offset from X-Server-Time on a plain answer', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: 1 }, {
      headers: { 'Content-Type': 'application/json', 'X-Server-Time': new Date(Date.now() - 6_000).toISOString() },
    }))
    await apiGet('/api/x')
    expect(serverClockOffsetMs()).toBeGreaterThanOrEqual(5_500) // ~6 s ahead, plus test jitter
  })

  it('learns nothing from an answer without the header (older backend)', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: 1 }))
    await apiGet('/api/x')
    expect(serverClockOffsetMs()).toBeNull()
  })
})
