// Small fetch wrapper for the kp-front backend. Always sends cookies so the
// httpOnly access/refresh cookies ride along, parses JSON, and throws a typed
// ApiError on any non-2xx so callers can branch on status (401 unauth, 429
// cooldown, …). Reused by every later phase — keep it generic.

// Base URL: empty in dev (Vite proxies /api to the backend), or a fully-qualified
// origin in a deployment that talks to the backend cross-origin.
const BASE = import.meta.env.VITE_KP_RUECK_URL ?? ''

export class ApiError extends Error {
  status: number
  detail: string
  /** seconds to wait, parsed from the Retry-After header when the server sends one (429) */
  retryAfter?: number
  constructor(status: number, detail: string, retryAfter?: number) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.retryAfter = retryAfter
  }
}

async function rawFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    credentials: 'include',
    // API JSON must never come from the HTTP cache: responses carry no Cache-Control, and
    // Safari's heuristic caching served stale poll results (an STT job stuck on "none").
    cache: 'no-store',
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  })
}

// Single-flight refresh: the access token lives 8h, the refresh cookie 7d. When any
// request 401s, we transparently try ONE `/api/auth/refresh` and retry — so a multi-day
// incident never strands at the login screen. Concurrent 401s share the same in-flight
// refresh promise instead of stampeding the endpoint.
let refreshInFlight: Promise<boolean> | null = null
function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = rawFetch('/api/auth/refresh', { method: 'POST' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => { refreshInFlight = null })
  }
  return refreshInFlight
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // /api/auth/* and /api/admin/* are excluded from the 401→refresh→retry below: a failing
  // login/refresh (or a wrong admin secret) must not loop or get silently double-submitted.
  const isAuthPath = path.startsWith('/api/auth/') || path.startsWith('/api/admin/')
  let res: Response
  try {
    res = await rawFetch(path, init)
  } catch {
    // network / CORS failure — no HTTP status to report
    throw new ApiError(0, 'Netzwerkfehler — Server nicht erreichbar')
  }

  // 401 on a non-auth path → attempt one refresh + retry. /api/auth/* is excluded so a
  // failing login/refresh can't loop.
  if (res.status === 401 && !isAuthPath) {
    const ok = await tryRefresh()
    if (ok) {
      try {
        res = await rawFetch(path, init)
      } catch {
        throw new ApiError(0, 'Netzwerkfehler — Server nicht erreichbar')
      }
    }
  }

  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body && typeof body.detail === 'string') detail = body.detail
      else if (Array.isArray(body?.detail)) {
        detail = body.detail.map((item: { loc?: unknown[]; msg?: string }) => {
          const field = Array.isArray(item.loc) ? item.loc.filter((part) => part !== 'body').join('.') : ''
          return `${field ? `${field}: ` : ''}${item.msg ?? 'Ungültiger Wert'}`
        }).join(' · ')
      }
    } catch { /* non-JSON error body — keep the status text */ }
    const ra = res.headers.get('Retry-After')
    const retryAfter = ra != null && ra !== '' ? Number(ra) : undefined
    throw new ApiError(res.status, detail, Number.isFinite(retryAfter) ? retryAfter : undefined)
  }

  // 204 / empty bodies: don't try to parse
  if (res.status === 204 || res.headers.get('Content-Length') === '0') return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' })
}

// Compress large JSON request bodies (the workspace blob is highly repetitive JSON —
// gzip cuts it ~8–10×, which matters on field LTE). Only bodies past the threshold pay
// the CPU; the backend's GzipRequestMiddleware transparently inflates them. Browsers
// without CompressionStream just send plain JSON.
const GZIP_THRESHOLD = 10 * 1024

async function gzipText(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return await new Response(stream).blob()
}

function withJson(method: string) {
  return async <T>(path: string, body?: unknown): Promise<T> => {
    if (body === undefined) return request<T>(path, { method })
    const json = JSON.stringify(body)
    // decide the encoding FIRST, then issue exactly ONE request — a catch around the
    // request itself would silently re-send after a failure (double-applied writes on a
    // lost response, masked 4xx errors), so only the compression step may fall back.
    let init: RequestInit = { method, headers: { 'Content-Type': 'application/json' }, body: json }
    if (json.length >= GZIP_THRESHOLD && typeof CompressionStream !== 'undefined') {
      try {
        const gz = await gzipText(json)
        init = { method, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gz }
      } catch { /* compression failed → plain JSON init stands */ }
    }
    return request<T>(path, init)
  }
}

export const apiPost = withJson('POST')
export const apiPut = withJson('PUT')
export const apiPatch = withJson('PATCH')

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

/** multipart upload (FormData). Lets the browser set the boundary Content-Type. */
export function apiUpload<T>(path: string, form: FormData, method = 'POST'): Promise<T> {
  return request<T>(path, { method, body: form })
}

/**
 * Fire-and-forget JSON request that survives page teardown. A normal fetch() is aborted
 * the moment the document unloads — and on iOS PWAs (backgrounded, screen locked, or
 * swiped away) that's the common case, so a last-ditch save issued from a teardown handler
 * never reaches the server. `keepalive: true` tells the browser to complete the request
 * after the page is gone. There's no live page left to act on the result, so we do NOT
 * refresh/retry and we ignore the response. Best-effort by nature: the browser caps the
 * combined body of all in-flight keepalive requests at ~64KB, so an oversized workspace
 * push can be dropped — the offline cache remains the same-device fallback either way.
 */
export function apiBeacon(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): void {
  try {
    void rawFetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* best-effort — nothing to recover to during teardown */ })
  } catch { /* JSON.stringify / fetch construction failure — best-effort */ }
}

/**
 * Raw GET that does NOT throw on a chosen set of "ok-ish" statuses (e.g. 304 for the
 * workspace live-follow poll). Returns the Response so the caller can branch on status.
 * A network failure throws `ApiError(0, …)` for consistency with `request()`.
 */
export async function apiGetRaw(path: string): Promise<Response> {
  try {
    return await rawFetch(path, { method: 'GET' })
  } catch {
    throw new ApiError(0, 'Netzwerkfehler — Server nicht erreichbar')
  }
}
