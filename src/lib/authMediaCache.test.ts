import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

type Handler = (event: Record<string, unknown>) => void

function serviceWorkerHarness() {
  const handlers = new Map<string, Handler>()
  const contexts = new Map<string, object>()
  const stores = new Map<string, Map<string, Response>>()
  const keyOf = (input: RequestInfo | URL) =>
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

  const cachesMock = {
    open: vi.fn(async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>()
      stores.set(name, store)
      return {
        match: async (input: RequestInfo | URL) => store.get(keyOf(input))?.clone(),
        put: async (input: RequestInfo | URL, response: Response) => { store.set(keyOf(input), response.clone()) },
        keys: async () => [...store.keys()].map((url) => new Request(url)),
        delete: async (input: RequestInfo | URL) => store.delete(keyOf(input)),
      }
    }),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  }
  let requestNo = 0
  const fetchMock = vi.fn(async (_request?: unknown, _init?: RequestInit) => new Response(`network-${++requestNo}`, { status: 200 }))
  const selfMock = {
    location: { origin: 'https://kp.test' },
    addEventListener: (type: string, handler: Handler) => { handlers.set(type, handler) },
    clients: { get: async (id: string) => {
      const context = contexts.get(id)
      return context ? { postMessage: () => { void message(id, context) } } : undefined
    } },
    kpReferenceCacheAllowed: undefined as undefined | ((event: { clientId: string }, request: Request) => Promise<boolean>),
  }

  const source = readFileSync(new URL('../../public/sw-media-cache.js', import.meta.url), 'utf8')
  function restart() {
    handlers.clear()
    new Function('self', 'caches', 'fetch', 'URL', 'Request', 'Response', 'Headers', source)(
      selfMock, cachesMock, fetchMock, URL, Request, Response, Headers,
    )
  }
  restart()

  async function message(clientId: string, data: object) {
    contexts.set(clientId, data)
    let pending: Promise<unknown> = Promise.resolve()
    handlers.get('message')?.({
      data,
      source: { id: clientId },
      waitUntil: (promise: Promise<unknown>) => { pending = promise },
    })
    await pending
  }

  async function media(clientId: string, path = '/api/media/m1') {
    let response: Promise<Response> | undefined
    let stopped = false
    handlers.get('fetch')?.({
      clientId,
      request: new Request(`https://kp.test${path}`),
      stopImmediatePropagation: () => { stopped = true },
      respondWith: (promise: Promise<Response>) => { response = promise },
    })
    expect(stopped).toBe(true)
    return (await response!).text()
  }

  async function reference(clientId: string, path: string, headers?: HeadersInit) {
    let response: Promise<Response> | undefined
    let stopped = false
    const request = new Request(`https://kp.test${path}`, { headers })
    handlers.get('fetch')?.({
      clientId,
      request,
      stopImmediatePropagation: () => { stopped = true },
      respondWith: (promise: Promise<Response>) => { response = promise },
    })
    // The generated Workbox hooks perform the same async session check for unknown clients;
    // known links are intercepted synchronously before Workbox can return an account entry.
    if (!response && selfMock.kpReferenceCacheAllowed && !await selfMock.kpReferenceCacheAllowed({ clientId }, request)) {
      stopped = true
      response = fetchMock(request, { cache: 'no-store' })
    }
    return { stopped, response: response ? await response : undefined }
  }

  const cacheAllowed = (id: string) => {
    if (!selfMock.kpReferenceCacheAllowed) throw new Error('reference session hook missing')
    return selfMock.kpReferenceCacheAllowed({ clientId: id }, new Request('https://kp.test/api/reference/plan%3Ax?v=1'))
  }
  return { cachesMock, fetchMock, media, reference, message, stores, restart, cacheAllowed }
}

describe('auth-aware service-worker media cache', () => {
  it('recovers the current account context from the page after an idle worker restart', async () => {
    const h = serviceWorkerHarness()
    await h.message('tablet', { type: 'kp-media-auth', kind: 'user', userId: 'user-a' })
    await h.media('tablet')
    h.restart()
    expect(await h.cacheAllowed('tablet')).toBe(true)
    expect(await h.media('tablet')).toBe('network-1') // cached media also survives the restart
    expect(h.fetchMock).toHaveBeenCalledOnce()
  })

  it('a restarted worker accepts the latest link/denied context, never an old account grant', async () => {
    const h = serviceWorkerHarness()
    await h.message('tablet', { type: 'kp-media-auth', kind: 'user', userId: 'user-a' })
    await h.message('tablet', { type: 'kp-media-auth', kind: 'link' })
    h.restart()
    expect(await h.cacheAllowed('tablet')).toBe(false)
    await h.message('tablet', { type: 'kp-media-auth', kind: 'logged-out' })
    h.restart()
    expect(await h.cacheAllowed('tablet')).toBe(false)
    expect(await h.cacheAllowed('unknown')).toBe(false)
  })
  it('is network-only for unknown and link clients', async () => {
    const h = serviceWorkerHarness()

    expect(await h.media('unknown')).toBe('network-1')
    await h.message('link', { type: 'kp-media-auth', kind: 'link' })
    expect(await h.media('link')).toBe('network-2')
    expect(h.stores.has('incident-media')).toBe(false)
  })

  it('caches only for its persisted owner and purges on user change or logout', async () => {
    const h = serviceWorkerHarness()
    await h.message('tablet', { type: 'kp-media-auth', kind: 'user', userId: 'user-a' })

    expect(await h.media('tablet')).toBe('network-1')
    expect(await h.media('tablet')).toBe('network-1')
    expect(h.fetchMock).toHaveBeenCalledTimes(1)

    await h.message('second-user', { type: 'kp-media-auth', kind: 'user', userId: 'user-b' })
    expect(await h.media('second-user')).toBe('network-2')
    // The old client remains known, but it no longer owns the cache and must go to network.
    expect(await h.media('tablet')).toBe('network-3')

    await h.message('second-user', { type: 'kp-media-auth', kind: 'link' })
    // Even on the same client, a link session cannot consume user B's cached response.
    expect(await h.media('second-user')).toBe('network-4')

    await h.message('second-user', { type: 'kp-media-auth', kind: 'logged-out' })
    expect(h.stores.has('incident-media')).toBe(false)
    expect(h.stores.has('kp-media-cache-owner')).toBe(false)
  })

  it('lets the server authorize every link/unknown reference read instead of a cached account answer', async () => {
    const h = serviceWorkerHarness()
    h.stores.set('reference-data', new Map([['https://kp.test/api/reference/objects', new Response('whole station register')]]))
    h.stores.set('reference-plans', new Map([['https://kp.test/api/reference/plan%3Aoutside?v=1', new Response('another incident plan')]]))
    h.fetchMock.mockImplementation(async () => new Response('link forbidden', { status: 403 }))
    await h.message('link', { type: 'kp-media-auth', kind: 'link' })
    for (const client of ['unknown', 'link']) {
      for (const path of ['/api/reference/objects', '/api/reference/building?lat=47&lng=7', '/api/reference/plan%3Aoutside?v=1', '/api/reference/plan%3Aoutside/tiles/1/1/0/0/0', '/api/reference/checklists%3Aoutside%3Ap1?v=1']) {
        const result = await h.reference(client, path)
        expect(result.stopped, `${client}: ${path}`).toBe(true)
        expect(result.response?.status).toBe(403)
        expect(await result.response?.text()).toBe('link forbidden')
      }
    }
    expect(h.fetchMock).toHaveBeenCalledTimes(10)
    for (const call of h.fetchMock.mock.calls) expect(call[1]?.cache).toBe('no-store')
    // The account still needs these offline: refusing the link must not delete its copy.
    expect(h.stores.has('reference-data')).toBe(true)
    expect(h.stores.has('reference-plans')).toBe(true)
  })

  it('preserves account reference caching, but an explicit link header bypasses it immediately', async () => {
    const h = serviceWorkerHarness()
    await h.message('tablet', { type: 'kp-media-auth', kind: 'user', userId: 'user-a' })
    const account = await h.reference('tablet', '/api/reference/plan%3Astation?v=1', { 'X-Incident-Link': 'off' })
    expect(account).toEqual({ stopped: false, response: undefined }) // Workbox owns account caching
    expect(h.fetchMock).not.toHaveBeenCalled()
    h.fetchMock.mockImplementation(async () => new Response('link forbidden', { status: 403 }))
    const forced = await h.reference('tablet', '/api/reference/plan%3Aoutside?v=1', { 'X-Incident-Link': 'use' })
    expect(forced.stopped).toBe(true)
    expect(forced.response?.status).toBe(403)
    // A headerless subresource on a handed-over link also bypasses the account cache.
    await h.message('tablet', { type: 'kp-media-auth', kind: 'link' })
    expect((await h.reference('tablet', '/api/reference/plan%3Aoutside?v=1')).response?.status).toBe(403)
  })
})
