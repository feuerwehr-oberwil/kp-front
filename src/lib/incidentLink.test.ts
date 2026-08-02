import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the HTTP layer, keep the REAL ApiError so `e instanceof ApiError` holds in the module.
const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }))
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, apiPost }
})

import { ApiError } from './api'
import {
  LINK_NOT_READY_ATTEMPTS, exchangeLinkToken, linkTokenFromPath, openIncidentLink,
  type LinkExchange,
} from './incidentLink'

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJpbmMiOiJhYmMifQ.sig-part_1'

// braces matter: a beforeEach that RETURNS something hands vitest a teardown callback, and
// mockReset() returns the mock itself — vitest would then call it after every test.
beforeEach(() => { apiPost.mockReset() })

describe('linkTokenFromPath', () => {
  it('reads the token out of /l/<token> (with and without a trailing slash)', () => {
    expect(linkTokenFromPath(`/l/${TOKEN}`)).toBe(TOKEN)
    expect(linkTokenFromPath(`/l/${TOKEN}/`)).toBe(TOKEN)
  })

  it('rejects anything that is not a link URL', () => {
    expect(linkTokenFromPath('/')).toBeNull()
    expect(linkTokenFromPath('/l/')).toBeNull()
    expect(linkTokenFromPath('/l/short')).toBeNull()      // too short to be a minted token
    expect(linkTokenFromPath(`/l/${TOKEN}/extra`)).toBeNull()
    expect(linkTokenFromPath(`/e/${TOKEN}`)).toBeNull()   // the capture poster, not a link
  })
})

describe('exchangeLinkToken', () => {
  it('returns the incident on success', async () => {
    apiPost.mockResolvedValue({ incident_id: 'inc-1' })
    await expect(exchangeLinkToken(TOKEN)).resolves.toEqual({ ok: true, incidentId: 'inc-1' })
    expect(apiPost).toHaveBeenCalledWith('/api/incident-link/session', { token: TOKEN })
  })

  it('403 → the station has Einsatz-Links switched off', async () => {
    apiPost.mockRejectedValue(new ApiError(403, 'nope'))
    await expect(exchangeLinkToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'disabled' })
  })

  it('401 → the link is invalid or expired', async () => {
    apiPost.mockRejectedValue(new ApiError(401, 'nope'))
    await expect(exchangeLinkToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'invalid' })
  })

  it('404 → not (yet) available — closed, archived and not-ingested are ONE reason', async () => {
    apiPost.mockRejectedValue(new ApiError(404, 'nope'))
    await expect(exchangeLinkToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'notReady' })
  })

  it('status 0 (no connection / timeout) → offline, not a server verdict', async () => {
    apiPost.mockRejectedValue(new ApiError(0, 'Server nicht erreichbar'))
    await expect(exchangeLinkToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'offline' })
  })

  it('a 500 and a 200 without an incident_id both read as a server fault', async () => {
    apiPost.mockRejectedValue(new ApiError(500, 'boom'))
    await expect(exchangeLinkToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'error' })
    apiPost.mockReset()
    apiPost.mockResolvedValue({})
    await expect(exchangeLinkToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'error' })
  })
})

describe('openIncidentLink — retry policy', () => {
  const run = (results: LinkExchange[]) => {
    const exchange = vi.fn<(t: string) => Promise<LinkExchange>>()
    for (const r of results) exchange.mockResolvedValueOnce(r)
    exchange.mockResolvedValue(results[results.length - 1]!) // keep answering after the list
    const pending: number[] = []
    const sleep = vi.fn().mockResolvedValue(undefined)
    return {
      exchange, pending, sleep,
      result: openIncidentLink('tok', { exchange, sleep, onPending: (n) => pending.push(n) }),
    }
  }

  it('does not retry a success', async () => {
    const t = run([{ ok: true, incidentId: 'inc-1' }])
    await expect(t.result).resolves.toEqual({ ok: true, incidentId: 'inc-1' })
    expect(t.exchange).toHaveBeenCalledTimes(1)
    expect(t.pending).toEqual([])
  })

  it('retries a not-yet-ingested incident and takes the success', async () => {
    const t = run([{ ok: false, reason: 'notReady' }, { ok: true, incidentId: 'inc-1' }])
    await expect(t.result).resolves.toEqual({ ok: true, incidentId: 'inc-1' })
    expect(t.exchange).toHaveBeenCalledTimes(2)
    expect(t.pending).toEqual([1]) // the screen showed «noch nicht verfügbar» once
  })

  it('gives up after the bounded number of attempts and settles on notReady', async () => {
    const t = run([{ ok: false, reason: 'notReady' }])
    await expect(t.result).resolves.toEqual({ ok: false, reason: 'notReady' })
    expect(t.exchange).toHaveBeenCalledTimes(LINK_NOT_READY_ATTEMPTS)
    expect(t.pending).toEqual([1, 2, 3])
    expect(t.sleep).toHaveBeenCalledTimes(LINK_NOT_READY_ATTEMPTS - 1)
  })

  it('never retries a verdict that waiting cannot change', async () => {
    for (const reason of ['disabled', 'invalid', 'offline', 'error'] as const) {
      const t = run([{ ok: false, reason }])
      await expect(t.result).resolves.toEqual({ ok: false, reason })
      expect(t.exchange).toHaveBeenCalledTimes(1)
      expect(t.pending).toEqual([])
    }
  })
})
