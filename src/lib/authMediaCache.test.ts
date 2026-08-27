import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

type Handler = (event: Record<string, unknown>) => void

function serviceWorkerHarness() {
  const handlers = new Map<string, Handler>()
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
  const fetchMock = vi.fn(async () => new Response(`network-${++requestNo}`, { status: 200 }))
  const selfMock = {
    location: { origin: 'https://kp.test' },
    addEventListener: (type: string, handler: Handler) => { handlers.set(type, handler) },
  }

  const source = readFileSync(new URL('../../public/sw-media-cache.js', import.meta.url), 'utf8')
  new Function('self', 'caches', 'fetch', 'URL', 'Request', 'Response', 'Headers', source)(
    selfMock, cachesMock, fetchMock, URL, Request, Response, Headers,
  )

  async function message(clientId: string, data: object) {
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

  return { cachesMock, fetchMock, media, message, stores }
}

describe('auth-aware service-worker media cache', () => {
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
})
