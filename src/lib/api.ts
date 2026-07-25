// Small fetch wrapper for the kp-front backend. Always sends cookies so the
// httpOnly access/refresh cookies ride along, parses JSON, and throws a typed
// ApiError on any non-2xx so callers can branch on status (401 unauth, 429
// cooldown, …). Reused by every later phase — keep it generic.

import { appConfig } from '../config/appConfig'

// Base URL: empty in dev (Vite proxies /api to the backend), or a fully-qualified
// origin in a deployment that talks to the backend cross-origin.
const BASE = import.meta.env.VITE_KP_RUECK_URL ?? ''

// Every request is time-bounded. `fetch` has NO default timeout, and the failure mode that
// matters in the field is not a refused connection (which rejects instantly) but a HALF-OPEN
// one: the tablet is still associated to a dying AP, holding one bar of LTE, or sitting behind
// a captive portal that completes the handshake and never answers. iOS then keeps the request
// pending for minutes. Without a bound that stalls the whole launch — the deployment-config
// load blocks first paint, the /me probe and the incident list each pin the boot Splash — and
// none of those screens carry an action, so the operator's only move is to kill the app, which
// re-hangs identically. Bounding here is what turns all three into the ALREADY-HANDLED offline
// path (cached user, cached incident list, cached workspace).
const DEFAULT_TIMEOUT_MS = 20_000
// Media (photos / voice memos) are up to ~100 MB and upload over field LTE, so they get a far
// longer leash — a premature abort would count a failed attempt against the upload queue.
const UPLOAD_TIMEOUT_MS = 5 * 60_000

/** AbortSignal that fires after `ms`. Guarded: an environment without AbortSignal.timeout
 *  simply keeps the old unbounded behaviour rather than failing every request. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined
}

/** Did this rejection come from our own timeout rather than a hard network failure? Used only
 *  to pick the operator-facing message — the ApiError status stays 0 either way, because every
 *  offline fallback in the app branches on `status === 0`. */
const isTimeout = (e: unknown): boolean =>
  e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')

function networkError(e: unknown): ApiError {
  const c = appConfig.copy.errors
  return new ApiError(0, isTimeout(e) ? c.serverTimeout : c.serverUnreachable)
}

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

async function rawFetch(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    credentials: 'include',
    // API JSON must never come from the HTTP cache: responses carry no Cache-Control, and
    // Safari's heuristic caching served stale poll results (an STT job stuck on "none").
    cache: 'no-store',
    // keepalive beacons outlive the page, so they must NOT carry a signal — the caller passes
    // timeoutMs: 0 to opt out. Everything else is bounded (see DEFAULT_TIMEOUT_MS).
    signal: timeoutMs > 0 ? timeoutSignal(timeoutMs) : undefined,
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

async function request<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  // /api/auth/* and /api/admin/* are excluded from the 401→refresh→retry below: a failing
  // login/refresh (or a wrong admin secret) must not loop or get silently double-submitted.
  const isAuthPath = path.startsWith('/api/auth/') || path.startsWith('/api/admin/')
  let res: Response
  try {
    res = await rawFetch(path, init, timeoutMs)
  } catch (e) {
    // network / CORS failure or our own timeout — no HTTP status to report
    throw networkError(e)
  }

  // 401 on a non-auth path → attempt one refresh + retry. /api/auth/* is excluded so a
  // failing login/refresh can't loop.
  if (res.status === 401 && !isAuthPath) {
    const ok = await tryRefresh()
    if (ok) {
      try {
        res = await rawFetch(path, init, timeoutMs)
      } catch (e) {
        throw networkError(e)
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
  return request<T>(path, { method, body: form }, UPLOAD_TIMEOUT_MS)
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
    }, 0 /* no timeout: the point of a beacon is to outlive this page */)
      .catch(() => { /* best-effort — nothing to recover to during teardown */ })
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
  } catch (e) {
    throw networkError(e)
  }
}
