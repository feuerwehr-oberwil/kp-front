// Small fetch wrapper for the kp-front backend. Always sends cookies so the
// httpOnly access/refresh cookies ride along, parses JSON, and throws a typed
// ApiError on any non-2xx so callers can branch on status (401 unauth, 429
// cooldown, …). Reused by every later phase — keep it generic.

import { appConfig } from '../config/appConfig'
import { noteServerTime } from './serverClock'
import { linkPageOwnsSession, linkSessionHeaders } from './linkMode'

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
/**
 * The bound for a LONG POLL (`?wait=1` on the workspace / journal live-follow reads). The server
 * deliberately holds those requests open until something changes — up to ~20 s (backend
 * app/live_wait · LONG_POLL_TIMEOUT_S) — so the normal 20 s bound would race the server's own
 * answer and turn every quiet round into a client-side timeout. The margin exists to keep this
 * ABOVE the server's hold; a genuinely half-open connection still gets cut here.
 *
 * ⚠️ Two of these are open at all times per tab (workspace + Verlauf). Over HTTP/2 — every
 * deployment, and the dev server with https — that costs nothing: one connection, multiplexed.
 * Over plain HTTP/1.1 they occupy 2 of the browser's 6 per-origin connections.
 */
export const LONG_POLL_TIMEOUT_MS = 35_000

/** AbortSignal that fires after `ms`. Guarded: an environment without AbortSignal.timeout
 *  simply keeps the old unbounded behaviour rather than failing every request. Exported for
 *  the few callers that must use a bare `fetch` (cross-origin tiles, the print relay's
 *  FormData posts, the peaks poll) — «no fetch may be unbounded» holds for them too. */
export function timeoutSignal(ms: number): AbortSignal | undefined {
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
  const timeout = isTimeout(e)
  const err = new ApiError(0, timeout ? c.serverTimeout : c.serverUnreachable)
  err.hint = timeout ? c.serverTimeoutHint : c.serverUnreachableHint
  return err
}

/**
 * What an HTTP status MEANS to the operator — used only when the server sent no message of its
 * own. That is the common case for exactly the failures that matter: a 502/504 comes from the
 * reverse proxy as an HTML page, so there is no `{detail}` to show and the screen fell back to a
 * bare «HTTP 502». That names the plumbing. It does not say whether the tablet, the link or the
 * server is at fault, whether waiting helps, or whether the Einsatz data is safe.
 *
 * `statusText` is no better: it is an English protocol phrase ("Bad Gateway"), and over HTTP/2
 * it is empty, which is why the screenshot said «HTTP 502» rather than anything at all.
 */
function statusMessage(status: number): { detail: string; hint?: string } | null {
  const c = appConfig.copy.errors
  if (status === 401) return { detail: c.httpUnauthorized, hint: c.httpUnauthorizedHint }
  if (status === 403) return { detail: c.httpForbidden, hint: c.httpForbiddenHint }
  if (status === 404) return { detail: c.httpNotFound, hint: c.httpNotFoundHint }
  if (status === 413) return { detail: c.httpTooLarge, hint: c.httpTooLargeHint }
  // 428 = this PAGE is out of date, not the request. The config PUT requires the version token
  // a browser can only have from a fresh load (api/config · put_config), so a tab older than the
  // guard lands here — and the answer is a reload, not a retry.
  if (status === 428) return { detail: c.httpStale, hint: c.httpStaleHint }
  if (status === 429) return { detail: c.httpTooMany, hint: c.httpTooManyHint }
  // 502/503/504: the server is down or restarting — the one case where waiting genuinely helps.
  if (status === 502 || status === 503 || status === 504) return { detail: c.httpGateway, hint: c.httpGatewayHint }
  if (status >= 500) return { detail: c.httpServerError, hint: c.httpServerErrorHint }
  if (status >= 400) return { detail: c.httpRejected, hint: c.httpRejectedHint }
  return null
}

export class ApiError extends Error {
  status: number
  detail: string
  /** One line on what to do about it, when we can say something useful. The `detail` alone is a
   *  diagnosis; the hint is the instruction, and at 3am the instruction is the point. */
  hint?: string
  /** seconds to wait, parsed from the Retry-After header when the server sends one (429) */
  retryAfter?: number
  /** Which FIELDS the server refused, when it answered with FastAPI's 422 validation array.
   *  `detail` flattens those into English Pydantic prose («Input should be a valid list»),
   *  which is what a German-speaking volunteer was shown when a coordinate went in wrong. A
   *  caller that knows its own document — the Verwaltung config editor — turns the dotted
   *  paths here into a sentence naming the field in the operator's language.
   *
   *  `kind` and `input` are FastAPI's `type` and `input` verbatim: the machine-readable half of
   *  the same answer. `kind` says what was EXPECTED («string_type») and `input` what was
   *  actually there («TLF 31») — the two things a config import has to say out loud, because
   *  the file is hand-edited and the shape is the whole question (admin/ConfigContext ·
   *  describeRejectedFields). */
  fields?: { path: string; msg: string; kind?: string; input?: unknown }[]
  /** WHICH refusal this is, when the backend named one — a `{code, message}` detail rather than
   *  a bare string. The status alone is often too coarse to act on: two 403s on the same route
   *  can mean «diese Wehr hat die Funktion nie eingerichtet» (an instruction: der Verwaltung) and
   *  «dieses Konto darf das nicht» (nothing to do), and a screen that keys on the status shows
   *  the wrong one of those half the time. `detail` still carries the German sentence, so a
   *  caller that does not know the code loses nothing. */
  code?: string
  constructor(status: number, detail: string, retryAfter?: number) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.retryAfter = retryAfter
  }
}

/**
 * Could the server not be ASKED — as opposed to having answered «no»? True for status 0 (no
 * network, our own timeout, a captive portal) and for 502/503/504, which come from the proxy
 * in front of a server that is down or restarting. To the operator these are one situation:
 * the session cookie and the cached Einsätze are as good as they were a minute ago, nothing
 * has been refused, and the offline fallbacks (cached user, cached incident list) apply. The
 * boot path used to branch on `status === 0` only, so a Railway restart during a launch bounced
 * a logged-in tablet to the PIN pad and emptied the launcher.
 */
export function isUnverifiable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504)
}

/**
 * Fired on `window` when a 401 could not be repaired by the refresh: the session is gone for
 * good (refresh cookie expired mid-incident, SECRET_KEY rotated, server redeployed with a fresh
 * secret). Every later request fails the same way, so it is said ONCE here, where every request
 * passes, rather than guessed from the sync badge. AuthProvider listens and exposes it as
 * `sessionExpired`; nothing in this module knows about React.
 */
export const SESSION_EXPIRED_EVENT = 'kp:session-expired'

/** One signal that fires when EITHER input does. The long-poll loops need both halves: the
 *  timeout still cuts a half-open connection, and the caller's own controller drops a request
 *  the server is deliberately holding open (tab hidden, incident switched, hook torn down). */
export function eitherSignal(a?: AbortSignal, b?: AbortSignal | null): AbortSignal | undefined {
  if (!a) return b ?? undefined
  if (!b) return a
  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  if (a.aborted || b.aborted) abort()
  return ctrl.signal
}

/**
 * One request to our own backend: cookies, the JSON cache ban, the timeout — and the header
 * that says WHICH session this page is asking with.
 *
 * ⚠️ The invariant, and it is not local to this function: **every `/api` request the app makes
 * carries `X-Incident-Link`** (lib/linkMode · `linkSessionHeaders()`). The link session rides a
 * site-wide cookie because a subresource can carry no header of ours, so a request that stays
 * silent leaves the server inferring the session from whatever Einsatz-Link cookie happens to
 * be lying in this browser — the abolished precedence (backend/app/auth/incident_link.py ·
 * `LINK_MODE_HEADER`). One bare `fetch` is enough to bring it back for that route: the ordinary
 * app would answer as a link viewer, or the handed-over Atemschutz board as the device's login.
 *
 * So: a NEW request goes through this client and inherits it. A callsite that genuinely cannot
 * — a Blob or streaming response, a FormData body, its own abort clock, a poster token — keeps
 * its `fetch` and spreads `linkSessionHeaders()` into its `headers`, ahead of the caller's own
 * (reportPdf, zeitplanPrint, printRelay, captureClient, useShareMyPosition, StationWorkbookView
 * all do). Nothing under `/api` is exempt; a cross-origin URL (tiles, swisstopo) is not ours and
 * must not carry it.
 */
async function rawFetch(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    // API JSON must never come from the HTTP cache: responses carry no Cache-Control, and
    // Safari's heuristic caching served stale poll results (an STT job stuck on "none").
    cache: 'no-store',
    ...init,
    // keepalive beacons outlive the page, so they must NOT carry a signal — the caller passes
    // timeoutMs: 0 to opt out. Everything else is bounded (see DEFAULT_TIMEOUT_MS). Set AFTER
    // the spread so a caller's `signal` joins the timeout instead of silently replacing it.
    signal: eitherSignal(timeoutMs > 0 ? timeoutSignal(timeoutMs) : undefined, init?.signal),
    // …and WHICH session this page is asking with (lib/linkMode · the X-Incident-Link header).
    // The ordinary app never borrows an Einsatz-Link cookie left in the browser, and a link
    // page never borrows — or touches — the device's login. Before the caller's own headers,
    // so nothing but a deliberate override can misstate it.
    headers: { Accept: 'application/json', ...linkSessionHeaders(), ...(init?.headers ?? {}) },
  })
  // Every /api/ answer carries the server's own clock (backend · api_server_time), so THIS is
  // the sampling point: the boot config/`/me` fetches already teach lib/serverClock the offset
  // before the first Atemschutz clock is ever painted, and every later request keeps it honest.
  // Error responses count too — an offline device learns nothing, and that is handled there.
  noteServerTime(res.headers.get('X-Server-Time'))
  return res
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
  // failing login/refresh can't loop, and so is a page whose own link session is the
  // authority: its 401 is about the LINK, and refreshing would renew a device login the link
  // page has no business touching (and could not use anyway).
  if (res.status === 401 && !isAuthPath && !linkPageOwnsSession()) {
    const ok = await tryRefresh()
    if (ok) {
      try {
        res = await rawFetch(path, init, timeoutMs)
      } catch (e) {
        throw networkError(e)
      }
    } else if (typeof window !== 'undefined') {
      // the refresh itself was refused: this session cannot be repaired from here (see
      // SESSION_EXPIRED_EVENT). The 401 still propagates to the caller below.
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    }
  }

  if (!res.ok) {
    // Our own backend speaks German and knows the situation, so its {detail} always wins. Only
    // when it said nothing (a proxy error page, an empty body) do we explain the status
    // ourselves — and the bare "HTTP n" is the last resort, not the first.
    const mapped = statusMessage(res.status)
    let detail = mapped?.detail ?? res.statusText ?? ''
    let hint = mapped?.hint
    let fields: { path: string; msg: string; kind?: string; input?: unknown }[] | undefined
    let code: string | undefined
    try {
      const body = await res.json()
      if (body && typeof body.detail === 'string') { detail = body.detail; hint = undefined }
      // …or the same answer with a name on it: `{code, message}`, for the refusals a screen has
      // to TELL APART rather than merely display (see ApiError.code). The message is the same
      // German sentence a string detail would have carried, so nothing is lost by ignoring code.
      else if (body?.detail && typeof body.detail === 'object' && typeof body.detail.message === 'string') {
        detail = body.detail.message
        code = typeof body.detail.code === 'string' ? body.detail.code : undefined
        hint = undefined
      }
      else if (Array.isArray(body?.detail)) {
        // Kept as structured pairs as well as the flattened line: the flattened one is English
        // Pydantic prose and only a caller that knows the document can say what it means (see
        // ApiError.fields).
        const parsed: { path: string; msg: string; kind?: string; input?: unknown }[] = body.detail.map(
          (item: { loc?: unknown[]; msg?: string; type?: string; input?: unknown }) => ({
            path: Array.isArray(item.loc) ? item.loc.filter((part) => part !== 'body').join('.') : '',
            msg: item.msg ?? 'Ungültiger Wert',
            kind: item.type,
            input: item.input,
          }),
        )
        fields = parsed
        detail = parsed.map(({ path, msg }) => `${path ? `${path}: ` : ''}${msg}`).join(' · ')
        hint = undefined
      }
    } catch { /* non-JSON error body (the usual proxy HTML) — the mapped wording stands */ }
    if (!detail) detail = `HTTP ${res.status}`
    const ra = res.headers.get('Retry-After')
    const retryAfter = ra != null && ra !== '' ? Number(ra) : undefined
    const err = new ApiError(res.status, detail, Number.isFinite(retryAfter) ? retryAfter : undefined)
    err.hint = hint
    err.fields = fields
    err.code = code
    throw err
  }

  // 204 / empty bodies: don't try to parse
  if (res.status === 204 || res.headers.get('Content-Length') === '0') return undefined as T
  const text = await res.text()
  try {
    return (text ? JSON.parse(text) : undefined) as T
  } catch {
    // A 200 whose body is not JSON is a captive portal or an interception proxy answering
    // for the backend — the coffee-shop/hotel WLAN case, and one a fire station hits on any
    // guest network. Raw, this threw a SyntaxError instead of an ApiError, so the callers'
    // `status === 0` offline branches never ran: `listIncidentsResilient` gave up its cached
    // list and AuthProvider dropped the user at the login screen, with a perfectly good
    // offline cache sitting untouched behind it. Reported as unreachable, which is the truth.
    throw new ApiError(0, 'Server nicht erreichbar (unerwartete Antwort)')
  }
}

/** Per-call overrides for the two live-follow GETs. `signal` makes a held long poll abortable
 *  (teardown / incident switch / tab hidden); `timeoutMs` lifts the bound above the server's
 *  hold (see LONG_POLL_TIMEOUT_MS). Everything else keeps the plain defaults. */
export interface GetOpts {
  signal?: AbortSignal
  timeoutMs?: number
}

export function apiGet<T>(path: string, opts?: GetOpts): Promise<T> {
  return request<T>(path, { method: 'GET', signal: opts?.signal }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
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
  /** `extra` adds request headers — used for the `If-Match` version token on the
   *  full-document config PUT (see admin/ConfigContext). */
  return async <T>(path: string, body?: unknown, extra?: Record<string, string>): Promise<T> => {
    if (body === undefined) return request<T>(path, { method, headers: extra })
    const json = JSON.stringify(body)
    // decide the encoding FIRST, then issue exactly ONE request — a catch around the
    // request itself would silently re-send after a failure (double-applied writes on a
    // lost response, masked 4xx errors), so only the compression step may fall back.
    let init: RequestInit = { method, headers: { 'Content-Type': 'application/json', ...extra }, body: json }
    if (json.length >= GZIP_THRESHOLD && typeof CompressionStream !== 'undefined') {
      try {
        const gz = await gzipText(json)
        init = { method, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ...extra }, body: gz }
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
export async function apiGetRaw(path: string, opts?: GetOpts): Promise<Response> {
  try {
    return await rawFetch(path, { method: 'GET', signal: opts?.signal }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch (e) {
    throw networkError(e)
  }
}
