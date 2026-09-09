import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the HTTP layer, keep the REAL ApiError so `e instanceof ApiError` holds in the module.
const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }))
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, apiPost }
})

import { ApiError } from './api'
import { exchangeStandingToken, exchangeTerminalSession } from './standingLink'

const TOKEN = 'sSECRET-secret-secret'

// braces matter: a beforeEach that RETURNS something hands vitest a teardown callback, and
// mockReset() returns the mock itself — vitest would then call it after every test.
beforeEach(() => { apiPost.mockReset() })

describe('exchangeStandingToken', () => {
  it('«ok» carries the resolved Einsatz', async () => {
    apiPost.mockResolvedValue({ status: 'ok', incident_id: 'inc-1' })
    await expect(exchangeStandingToken(TOKEN)).resolves.toEqual({ ok: true, resolution: { status: 'ok', incidentId: 'inc-1' } })
    expect(apiPost).toHaveBeenCalledWith('/api/incident-link/session', { token: TOKEN })
  })

  it('passes the bound Einsatz along, so a made choice sticks across the poll', async () => {
    apiPost.mockResolvedValue({ status: 'ok', incident_id: 'inc-2' })
    await exchangeStandingToken(TOKEN, 'inc-2')
    expect(apiPost).toHaveBeenCalledWith('/api/incident-link/session', { token: TOKEN, incident_id: 'inc-2' })
  })

  it('«idle» and «choose» are ordinary answers, not failures', async () => {
    apiPost.mockResolvedValueOnce({ status: 'idle' })
    await expect(exchangeStandingToken(TOKEN)).resolves.toEqual({ ok: true, resolution: { status: 'idle' } })

    const candidates = [{ id: 'a', title: 'Brand', address: null, started_at: null, is_exercise: false }]
    apiPost.mockResolvedValueOnce({ status: 'choose', candidates })
    await expect(exchangeStandingToken(TOKEN)).resolves.toEqual({ ok: true, resolution: { status: 'choose', candidates } })
  })

  it('maps the refusals: 401 invalid (rotated/unknown), 403 disabled, status 0 offline', async () => {
    apiPost.mockRejectedValueOnce(new ApiError(401, 'nope'))
    await expect(exchangeStandingToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'invalid' })
    apiPost.mockRejectedValueOnce(new ApiError(403, 'nope'))
    await expect(exchangeStandingToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'disabled' })
    apiPost.mockRejectedValueOnce(new ApiError(0, 'kein Netz'))
    await expect(exchangeStandingToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'offline' })
  })

  it('a malformed 200 reads as a server fault, never as a state', async () => {
    apiPost.mockResolvedValue({ status: 'ok' }) // ok without an incident_id
    await expect(exchangeStandingToken(TOKEN)).resolves.toEqual({ ok: false, reason: 'error' })
  })
})

describe('exchangeTerminalSession', () => {
  it('polls the cookie door without a token', async () => {
    apiPost.mockResolvedValue({ status: 'idle' })
    await expect(exchangeTerminalSession()).resolves.toEqual({ ok: true, resolution: { status: 'idle' } })
    expect(apiPost).toHaveBeenCalledWith('/api/incident-link/terminal-session', {})
  })

  it('carries the bound Einsatz like the token door does', async () => {
    apiPost.mockResolvedValue({ status: 'ok', incident_id: 'inc-1' })
    await exchangeTerminalSession('inc-1')
    expect(apiPost).toHaveBeenCalledWith('/api/incident-link/terminal-session', { incident_id: 'inc-1' })
  })
})
