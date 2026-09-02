// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the HTTP layer but keep the REAL ApiError so AuthProvider's `e instanceof ApiError` holds.
const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }))
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, apiGet, apiPost }
})
const { idbSet, idbDel } = vi.hoisted(() => ({ idbSet: vi.fn(), idbDel: vi.fn() }))
vi.mock('./idb', () => ({ idbGet: vi.fn().mockResolvedValue(null), idbSet, idbDel }))
const { syncMediaCacheAuth } = vi.hoisted(() => ({ syncMediaCacheAuth: vi.fn() }))
vi.mock('./authMediaCache', () => ({ syncMediaCacheAuth }))

import { ApiError, SESSION_EXPIRED_EVENT } from './api'
import { idbGet } from './idb'
import * as deploymentConfig from './deploymentConfig'
import type { DeploymentConfig } from './deploymentConfig'
import { AuthProvider, useAuth } from './auth'

const EDITOR = { id: 'ed-1', display_name: 'FU', role: 'editor', color: null }
const VIEWER = { id: 'vw-1', display_name: 'Betrachter', role: 'viewer', color: null }
const EDITOR_USER = { id: 'ed-1', username: 'fu', display_name: 'FU', role: 'editor', color: null, last_login: null }

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>

const LINK_USER = {
  id: 'lk-1', username: 'link', display_name: 'Einsatz-Link', role: 'viewer', color: null,
  last_login: null, link_scoped: true, link_incident_id: 'inc-1',
}

beforeEach(() => {
  apiGet.mockReset(); apiPost.mockReset(); idbSet.mockReset(); idbDel.mockReset(); syncMediaCacheAuth.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('AuthProvider — offline user cache', () => {
  it('caches a real login (that is what keeps the PWA usable with no signal)', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet.mockResolvedValue(EDITOR_USER)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.user).toEqual(EDITOR_USER))
    expect(idbSet).toHaveBeenCalledWith('kp-front-user', EDITOR_USER)
    await waitFor(() => expect(syncMediaCacheAuth).toHaveBeenCalledWith(EDITOR_USER))
  })

  it('never caches an Einsatz-Link session, and clears whatever was cached', async () => {
    // the cache means "the cookie is still good, we just can't verify it right now" — untrue
    // for a link, which dies with the Einsatz and would otherwise resurrect offline forever
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet.mockResolvedValue(LINK_USER)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.user).toEqual(LINK_USER))
    expect(idbSet).not.toHaveBeenCalled()
    expect(idbDel).toHaveBeenCalledWith('kp-front-user')
    await waitFor(() => expect(syncMediaCacheAuth).toHaveBeenCalledWith(LINK_USER))
  })
})

describe('AuthProvider — demo auto-login', () => {
  it('refreshes session-only config before mounting the field app', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(true)
    let releaseConfig!: (cfg: DeploymentConfig) => void
    const configRefresh = new Promise<DeploymentConfig>((resolve) => { releaseConfig = resolve })
    const loadConfig = vi.spyOn(deploymentConfig, 'loadDeploymentConfig').mockReturnValue(configRefresh)
    apiGet.mockImplementation((path: string) =>
      path === '/api/auth/roster' ? Promise.resolve([EDITOR]) : Promise.reject(new ApiError(401, 'unauth')))
    apiPost.mockResolvedValue(EDITOR_USER)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(loadConfig).toHaveBeenCalledOnce())
    // Anonymous /api/config withholds the CARTO browser key. Exposing the user before this
    // refresh mounts the map with unkeyed, visibly watermarked tiles until a full reload.
    expect(result.current.user).toBeNull()

    releaseConfig({ integrations: { cartoBasemapKey: 'demo-key' } })
    await waitFor(() => expect(result.current.user).toEqual(EDITOR_USER))
  })

  it('signs in as the demo editor when there is no session (demo instance → no login screen)', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(true)
    vi.spyOn(deploymentConfig, 'loadDeploymentConfig').mockResolvedValue({})
    apiGet.mockImplementation((path: string) =>
      path === '/api/auth/roster' ? Promise.resolve([VIEWER, EDITOR]) : Promise.reject(new ApiError(401, 'unauth')))
    apiPost.mockResolvedValue(EDITOR_USER)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.user).toEqual(EDITOR_USER))
    // picked the editor (not the viewer) and used the public demo PIN
    expect(apiPost).toHaveBeenCalledWith('/api/auth/login', { user_id: 'ed-1', pin: '000000' })
  })

  it('does NOT auto-login on a real (non-demo) station', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet.mockRejectedValue(new ApiError(401, 'unauth'))

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.user).toBeNull()
    expect(apiPost).not.toHaveBeenCalled()
    await waitFor(() => expect(syncMediaCacheAuth).toHaveBeenCalledWith(null))
  })
})

describe('AuthProvider — a server that could not be asked', () => {
  // The boot probe used to branch on status 0 alone, so a 502/503/504 from the proxy in
  // front of a restarting server — a Railway deploy during a launch — bounced a logged-in
  // tablet to the PIN pad although its cookie was fine. Silence and a gateway error are one
  // situation to the operator (api · isUnverifiable); a real 401 still logs out.
  it('restores the cached user on a gateway error, probing with the short bound', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    vi.mocked(idbGet).mockResolvedValueOnce(EDITOR_USER)
    apiGet.mockRejectedValue(new ApiError(503, 'Server nicht erreichbar'))

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.user).toEqual(EDITOR_USER))
    expect(result.current.probeUnreachable).toBe(false)
    // 7 s, not 20: the cached user is the answer, and it has to land before the Splash's 9 s
    // «Neu starten» — obeying that button used to restart the probe from zero
    expect(apiGet).toHaveBeenCalledWith('/api/auth/me', { timeoutMs: 7_000 })
  })

  it('says «unreachable» rather than «logged out» when there is no cache either', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.user).toBeNull()
    expect(result.current.probeUnreachable).toBe(true)
    expect(idbDel).not.toHaveBeenCalled() // nothing was refused, nothing is cleared
    expect(apiGet).toHaveBeenCalledWith('/api/auth/me', undefined) // no cache → the full bound
  })
})

describe('AuthProvider — a dead Einsatz-Link cookie', () => {
  // The Einsatz a link named has closed; while its cookie lives every credential-gated route
  // (roster, login, /me) answers 403, so the kiosk login is unreachable on that phone for up to
  // 12 h. Logout is exempt from that liveness check: shed the cookie, ask once more.
  it('sheds the cookie through logout and re-probes exactly once', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet
      .mockRejectedValueOnce(new ApiError(403, 'Für diesen Einsatz-Link nicht freigegeben'))
      .mockRejectedValueOnce(new ApiError(401, 'unauth'))
    apiPost.mockResolvedValue(undefined)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(apiPost).toHaveBeenCalledWith('/api/auth/logout')
    expect(apiGet).toHaveBeenCalledTimes(2)
    expect(result.current.user).toBeNull() // → the ordinary login screen, not a 403 dead end
    expect(idbDel).toHaveBeenCalledWith('kp-front-user')
  })

  it('does not loop when the re-probe is refused again', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet.mockRejectedValue(new ApiError(403, 'nope'))
    apiPost.mockResolvedValue(undefined)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(apiGet).toHaveBeenCalledTimes(2)
    expect(apiPost).toHaveBeenCalledTimes(1)
  })
})

describe('AuthProvider — session expiry mid-use', () => {
  it('flags kp:session-expired and clears it on logout', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet.mockResolvedValue(EDITOR_USER)
    apiPost.mockResolvedValue(undefined)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.user).toEqual(EDITOR_USER))
    expect(result.current.sessionExpired).toBe(false)

    act(() => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)) })
    expect(result.current.sessionExpired).toBe(true)
    expect(result.current.user).toEqual(EDITOR_USER) // the workspace keeps working on its cache

    await act(() => result.current.logout())
    expect(result.current.sessionExpired).toBe(false)
  })
})
