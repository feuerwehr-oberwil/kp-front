// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// SEC-10. `kp:session-expired` is fired by api.ts when a 401 could not be repaired — but the
// refresh POST that decides it counts a NETWORK failure as a refusal too, so the event alone
// cannot be trusted to mean «the server said no». AuthProvider therefore asks once more, and
// only a reachable server's 401/403 locks the device out of its caches. Silence changes nothing:
// the cached session, the cached media and the cached workspace stay exactly as they were.
const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }))
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, apiGet, apiPost }
})
const { idbSet, idbDel } = vi.hoisted(() => ({ idbSet: vi.fn(), idbDel: vi.fn() }))
vi.mock('./idb', () => ({ idbGet: vi.fn().mockResolvedValue(null), idbSet, idbDel }))
const { syncMediaCacheAuth } = vi.hoisted(() => ({ syncMediaCacheAuth: vi.fn() }))
vi.mock('./authMediaCache', () => ({ syncMediaCacheAuth }))
const { denyWorkspaceCache, setWorkspaceCacheOwner } = vi.hoisted(() => ({
  denyWorkspaceCache: vi.fn(), setWorkspaceCacheOwner: vi.fn(),
}))
vi.mock('./api/workspaceSync', () => ({ denyWorkspaceCache, setWorkspaceCacheOwner }))

import { ApiError, SESSION_EXPIRED_EVENT } from './api'
import * as deploymentConfig from './deploymentConfig'
import { AuthProvider, useAuth } from './auth'

const EDITOR_USER = { id: 'ed-1', username: 'fu', display_name: 'FU', role: 'editor', color: null, last_login: null }
const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>

/** boot straight into a signed-in session, with the config re-read out of the way */
async function signedIn() {
  vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
  vi.spyOn(deploymentConfig, 'getDeploymentConfig').mockReturnValue({ integrations: { cartoBasemapKey: 'k' } })
  apiGet.mockResolvedValueOnce(EDITOR_USER)
  const { result } = renderHook(() => useAuth(), { wrapper })
  await waitFor(() => expect(result.current.user).toEqual(EDITOR_USER))
  syncMediaCacheAuth.mockClear(); idbDel.mockClear(); setWorkspaceCacheOwner.mockClear()
  return result
}

beforeEach(() => {
  apiGet.mockReset(); apiPost.mockReset(); idbSet.mockReset(); idbDel.mockReset()
  syncMediaCacheAuth.mockReset(); denyWorkspaceCache.mockReset(); setWorkspaceCacheOwner.mockReset()
})
// ⚠️ No global RTL auto-cleanup in this repo (vite.config · test has no setupFiles), and these
// tests fire a WINDOW event: a provider left mounted by the previous test would answer it too.
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('AuthProvider — a session the server has explicitly refused', () => {
  it('locks the device out of its caches at once, and keeps the unsynced work', async () => {
    const result = await signedIn()
    apiGet.mockRejectedValueOnce(new ApiError(401, 'Nicht angemeldet')) // the confirming /me

    act(() => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)) })

    // the app falls back to the kiosk login (main · Gate renders it on a null user)
    await waitFor(() => expect(result.current.user).toBeNull())
    // …the worker is told, so the media cache stops answering (authMediaCache · «logged-out»)
    await waitFor(() => expect(syncMediaCacheAuth).toHaveBeenCalledWith(null))
    expect(denyWorkspaceCache).toHaveBeenCalled()
    expect(idbDel).toHaveBeenCalledWith('kp-front-user') // no offline restore of a dead session
    expect(setWorkspaceCacheOwner).toHaveBeenLastCalledWith(null)
  })

  it.each([0, 503])('changes NOTHING when the server could not be asked (%i)', async (status) => {
    const result = await signedIn()
    apiGet.mockRejectedValueOnce(new ApiError(status, 'Netzwerkfehler'))

    act(() => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)) })

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2)) // asked, and got silence
    expect(result.current.sessionExpired).toBe(true) // the Meldung says so — honestly
    expect(result.current.user).toEqual(EDITOR_USER) // …and the workspace keeps working offline
    expect(denyWorkspaceCache).not.toHaveBeenCalled()
    expect(syncMediaCacheAuth).not.toHaveBeenCalledWith(null)
    expect(idbDel).not.toHaveBeenCalled()
  })

  it('withdraws the warning when the session turns out to be alive after all', async () => {
    const result = await signedIn()
    apiGet.mockResolvedValueOnce(EDITOR_USER) // another tab had refreshed it

    act(() => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)) })

    await waitFor(() => expect(result.current.sessionExpired).toBe(false))
    expect(result.current.user).toEqual(EDITOR_USER)
    expect(denyWorkspaceCache).not.toHaveBeenCalled()
  })

  it('asks only once while the answer is still outstanding', async () => {
    const result = await signedIn()
    apiGet.mockRejectedValue(new ApiError(401, 'Nicht angemeldet'))

    act(() => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    })
    await waitFor(() => expect(result.current.user).toBeNull())
    expect(apiGet).toHaveBeenCalledTimes(2) // the boot probe and ONE confirmation
  })
})

// The other end of the same signal. `syncMediaCacheAuth(null)` posts «logged-out» to the worker
// (authMediaCache), and the worker has to answer it for the whole BROWSER: every tab rides the
// one cookie the server just refused, so a second tab must not keep reading the media cache
// until it happens to make its own failing request. Driven straight against the worker source,
// the way authMediaCache.test.ts does — there is no other way to exercise a service worker.
describe('sw-media-cache — a denial converges across tabs', () => {
  it('drops every tab’s grant, not just the one that noticed', async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>()
    const stores = new Map<string, Map<string, Response>>()
    const cachesMock = {
      open: async (name: string) => {
        const store = stores.get(name) ?? new Map<string, Response>()
        stores.set(name, store)
        const keyOf = (i: RequestInfo | URL) => (typeof i === 'string' ? i : i instanceof URL ? i.toString() : i.url)
        return {
          match: async (i: RequestInfo | URL) => store.get(keyOf(i))?.clone(),
          put: async (i: RequestInfo | URL, r: Response) => { store.set(keyOf(i), r.clone()) },
          keys: async () => [...store.keys()].map((url) => new Request(url)),
          delete: async (i: RequestInfo | URL) => store.delete(keyOf(i)),
        }
      },
      delete: async (name: string) => stores.delete(name),
    }
    let n = 0
    const fetchMock = vi.fn(async () => new Response(`network-${++n}`, { status: 200 }))
    const selfMock = {
      location: { origin: 'https://kp.test' },
      addEventListener: (type: string, h: (event: Record<string, unknown>) => void) => { handlers.set(type, h) },
    }
    // …from the repo root: under jsdom `import.meta.url` is an http URL, not a file one.
    const source = (await import('node:fs')).readFileSync(`${process.cwd()}/public/sw-media-cache.js`, 'utf8')
    new Function('self', 'caches', 'fetch', 'URL', 'Request', 'Response', 'Headers', source)(
      selfMock, cachesMock, fetchMock, URL, Request, Response, Headers,
    )
    const message = async (clientId: string, data: object) => {
      let pending: Promise<unknown> = Promise.resolve()
      handlers.get('message')?.({ data, source: { id: clientId }, waitUntil: (p: Promise<unknown>) => { pending = p } })
      await pending
    }
    const media = async (clientId: string) => {
      let response: Promise<Response> | undefined
      handlers.get('fetch')?.({
        clientId,
        request: new Request('https://kp.test/api/media/m1'),
        stopImmediatePropagation: () => {},
        respondWith: (p: Promise<Response>) => { response = p },
      })
      return (await response!).text()
    }

    // two tabs of the same session; the cache answers the second read without the network
    await message('tab-a', { type: 'kp-media-auth', kind: 'user', userId: 'ed-1' })
    await message('tab-b', { type: 'kp-media-auth', kind: 'user', userId: 'ed-1' })
    expect(await media('tab-a')).toBe('network-1')
    expect(await media('tab-b')).toBe('network-1')

    // Station reference data (symbols/geojson) is not owner-scoped, so an explicit denial must
    // purge it too — otherwise a revoked device keeps reading it. Seed it as Workbox would.
    stores.set('reference-data', new Map([['https://kp.test/api/reference/symbols', new Response('ref')]]))

    // tab A is the one whose request 401s → the whole device loses the cache and every grant
    await message('tab-a', { type: 'kp-media-auth', kind: 'logged-out' })
    expect(stores.has('incident-media')).toBe(false)
    expect(stores.has('reference-data')).toBe(false) // …the reference cache is gone as well
    expect(await media('tab-b')).toBe('network-2')
    expect(await media('tab-b')).toBe('network-3') // …and nothing is being cached for it either
  })
})

describe('AuthProvider — the boot probe is refused', () => {
  it.each([401, 403])('an explicit %i clears the cached identity, so no offline boot restores a dead session', async (status) => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet.mockRejectedValueOnce(new ApiError(status, 'refused'))
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.user).toBeNull()
    expect(idbDel).toHaveBeenCalledWith('kp-front-user') // the 403 used to leave the identity behind
  })

  it.each([0, 503])('keeps the cached identity when the server could not be asked (%i)', async (status) => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet.mockRejectedValueOnce(new ApiError(status, 'Netzwerkfehler'))
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(idbDel).not.toHaveBeenCalled() // silence refuses nothing — the cached session stands
  })
})

describe('AuthProvider — signing out and back in', () => {
  it('treats an explicit logout as a refusal too', async () => {
    const result = await signedIn()
    apiPost.mockResolvedValue(undefined)

    await act(() => result.current.logout())

    expect(denyWorkspaceCache).toHaveBeenCalled()
    expect(setWorkspaceCacheOwner).toHaveBeenLastCalledWith(null)
    expect(idbDel).toHaveBeenCalledWith('kp-front-user')
  })

  it('hands the caches back to the account that signs in', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    vi.spyOn(deploymentConfig, 'loadDeploymentConfig').mockResolvedValue({})
    apiGet.mockRejectedValue(new ApiError(401, 'unauth'))
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    apiPost.mockResolvedValue(EDITOR_USER)

    await act(() => result.current.login('ed-1', '123456'))

    // the owner id is what lifts the denial in the sync engine — same user, same cache
    expect(setWorkspaceCacheOwner).toHaveBeenLastCalledWith('ed-1')
    expect(result.current.sessionExpired).toBe(false)
  })
})
