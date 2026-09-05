// Auth-aware incident-media cache. Imported before Workbox registers its routes, so this
// listener owns /api/media/* and stops Workbox from installing a second, auth-blind route.
// Reference data stays station-scoped and remains under Workbox's normal runtime cache.
const KP_MEDIA_CACHE = 'incident-media'
const KP_MEDIA_OWNER_CACHE = 'kp-media-cache-owner'
const KP_MEDIA_OWNER_URL = new URL('/__kp/media-cache-owner', self.location.origin).toString()
const KP_MEDIA_MAX_ENTRIES = 200
const KP_MEDIA_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const kpMediaClients = new Map()

async function kpReadMediaOwner() {
  const cache = await caches.open(KP_MEDIA_OWNER_CACHE)
  const response = await cache.match(KP_MEDIA_OWNER_URL)
  return response ? response.text() : null
}

async function kpSetMediaOwner(userId) {
  const previous = await kpReadMediaOwner()
  if (previous !== userId) {
    // This also retires auth-blind entries left by releases before ownership existed.
    await caches.delete(KP_MEDIA_CACHE)
    const cache = await caches.open(KP_MEDIA_OWNER_CACHE)
    await cache.put(KP_MEDIA_OWNER_URL, new Response(userId))
  }
}

async function kpClearMediaOwner() {
  await Promise.all([
    caches.delete(KP_MEDIA_CACHE),
    caches.delete(KP_MEDIA_OWNER_CACHE),
  ])
}

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'kp-media-auth' || !event.source?.id) return
  const clientId = event.source.id
  if (event.data.kind === 'user' && typeof event.data.userId === 'string' && event.data.userId) {
    kpMediaClients.set(clientId, { kind: 'user', userId: event.data.userId })
    event.waitUntil(kpSetMediaOwner(event.data.userId))
  } else if (event.data.kind === 'link') {
    // A link may fetch media the backend authorizes, but never via another user's cache.
    kpMediaClients.set(clientId, { kind: 'link' })
  } else if (event.data.kind === 'logged-out') {
    // Sign-out AND explicit server denial arrive here (lib/auth · denySession). Both are about
    // the whole browser, not one tab: every client shares the one cookie the server just
    // refused, so every grant is dropped, not only the sender's. Other tabs fall back to
    // unknown — network-only, no cache read — and only their own next sign-in re-arms them.
    // A restarting worker starts with this same empty map, so it fails closed by construction.
    kpMediaClients.clear()
    event.waitUntil(kpClearMediaOwner())
  }
})

async function kpStoreMedia(cache, request, response) {
  const copy = response.clone()
  const headers = new Headers(copy.headers)
  headers.set('x-kp-cached-at', String(Date.now()))
  await cache.put(request, new Response(copy.body, {
    status: copy.status,
    statusText: copy.statusText,
    headers,
  }))
  const keys = await cache.keys()
  await Promise.all(keys.slice(0, Math.max(0, keys.length - KP_MEDIA_MAX_ENTRIES)).map((key) => cache.delete(key)))
}

async function kpNetworkMedia(request, cache) {
  const response = await fetch(request)
  if (cache && response.status === 200) await kpStoreMedia(cache, request, response)
  return response
}

async function kpHandleMedia(event) {
  const auth = kpMediaClients.get(event.clientId)
  if (!auth || auth.kind !== 'user') return kpNetworkMedia(event.request, null)

  const owner = await kpReadMediaOwner()
  if (owner !== auth.userId) return kpNetworkMedia(event.request, null)

  // Range responses are request-specific and must not be confused with the complete object.
  if (event.request.headers.has('range')) return kpNetworkMedia(event.request, null)

  const cache = await caches.open(KP_MEDIA_CACHE)
  const cached = await cache.match(event.request)
  if (cached) {
    const storedAt = Number(cached.headers.get('x-kp-cached-at'))
    if (Number.isFinite(storedAt) && Date.now() - storedAt <= KP_MEDIA_MAX_AGE_MS) return cached
  }

  try {
    return await kpNetworkMedia(event.request, cache)
  } catch (error) {
    // Preserve the old offline promise even after max-age; refresh it when signal returns.
    if (cached) return cached
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/api/media/')) return

  event.stopImmediatePropagation()
  event.respondWith(kpHandleMedia(event))
})
