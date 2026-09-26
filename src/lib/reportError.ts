import { apiBeacon } from './api'
import { APP_VERSION, GIT_SHA } from './buildInfo'

// Surface uncaught frontend errors to the server log so a solo operator's silent crash is
// visible to the deployer — the ErrorBoundary otherwise only console.errors, which nobody sees
// on a tablet in the field. Fire-and-forget (keepalive beacon), budgeted so a render loop can't
// flood the log. This must NEVER throw: a diagnostics path that errors is worse than no
// diagnostics.
//
// ⚠️ A repeat is COUNTED, never dropped (24.09.2026). Until then a second identical throw in the
// same page load was discarded outright, and that is how the crash that mattered on 23.09. went
// unseen: the iPad reported React #185 at 18:39, the Karte crashed again at 20:28 on the same
// page load, and the second one never left the tablet — the server log said the page had been
// fine for two hours. So now:
//   · the FIRST occurrence of a signature goes out in full (message, stack, component stack);
//   · every later one only bumps a counter, and the counter goes out as «×N since HH:MM» at most
//     once per REPEAT_EVERY_MS per signature — a crash two hours later is a line in the log at
//     most a minute after it happened;
//   · everything is paid for out of ONE token bucket (BUDGET_BURST now, one more per
//     BUDGET_REFILL_MS), so 10 000 throws in a burst are ≤ BUDGET_BURST requests and a storm
//     that never ends costs at most one request per refill period, forever. A report that has
//     to wait for a token WAITS — it is not lost; the counter keeps counting meanwhile.
// The signature includes the head of the component stack: React's #185 has the same message and
// the same (react-dom internal) stack head whichever component loops, so without it a loop in
// TwinTeamPill would have been filed as a repeat of one in IncidentWorkspace.

/** requests available at once — the first burst of distinct errors */
export const BUDGET_BURST = 20
/** …and one more per this long, sustained, for as long as the page lives */
export const BUDGET_REFILL_MS = 30_000
/** a signature's repeat counter goes out at most this often */
export const REPEAT_EVERY_MS = 60_000
/** distinct signatures tracked per page load; past it they are counted under one overflow row */
export const MAX_SIGNATURES = 50
/** at most this many requests in one second — keepalive requests share a small in-flight quota
 *  (64 kB in Chromium), and a burst beyond it is rejected by the browser, i.e. silently lost */
export const MAX_PER_SECOND = 4

const MAX_MESSAGE = 2000
const MAX_STACK = 8000
const MAX_COMPONENT_STACK = 8000

/**
 * `surface-recrash` is the SurfaceBoundary's «stürzt wiederholt ab» state — the view crashed
 * again after «Ansicht neu aufbauen» (or twice inside the crash window) — and `render-storm` is
 * lib/useRenderStorm's detector. Both are their own kind so one grep finds them.
 */
export type ErrorKind = 'render' | 'error' | 'unhandledrejection' | 'surface-recrash' | 'render-storm'

interface Ctx { kind?: ErrorKind; componentStack?: string; surface?: string }

interface Payload {
  kind: ErrorKind
  message: string
  stack?: string
  componentStack?: string
  path: string
  build: string
  surface?: string
  /** repeat reports only: occurrences since the last report of this signature */
  repeat?: number
  since?: string
  last?: string
}

interface Sig {
  /** the full first report, until it has gone out */
  first: Payload | null
  kind: ErrorKind
  message: string
  surface?: string
  /** occurrences not yet reported */
  pending: number
  pendingSince: number
  pendingLast: number
  lastSentAt: number
}

const OVERFLOW_KEY = '\u0000overflow'

let sigs = new Map<string, Sig>()
let tokens = BUDGET_BURST
let refilledAt = -1
let secondStart = 0
let sentThisSecond = 0
let timer: ReturnType<typeof setTimeout> | null = null

const build = (): string => `v${APP_VERSION}+${GIT_SHA}`
const currentPath = (): string => (typeof location === 'undefined' ? '' : location.pathname.slice(0, 400))

function refill(now: number): void {
  if (refilledAt < 0) { refilledAt = now; return }
  const earned = Math.floor((now - refilledAt) / BUDGET_REFILL_MS)
  if (earned <= 0) return
  tokens = Math.min(BUDGET_BURST, tokens + earned)
  refilledAt = tokens >= BUDGET_BURST ? now : refilledAt + earned * BUDGET_REFILL_MS
}

/** Spend one request, or say no. Both limits at once: the bucket and the per-second quota. */
function spend(now: number): boolean {
  refill(now)
  if (now - secondStart >= 1000) { secondStart = now; sentThisSecond = 0 }
  if (tokens < 1 || sentThisSecond >= MAX_PER_SECOND) return false
  tokens -= 1
  sentThisSecond += 1
  return true
}

/** When is the next request possible at all? */
function nextSpendAt(now: number): number {
  refill(now)
  const tokenAt = tokens >= 1 ? now : refilledAt + BUDGET_REFILL_MS
  const slotAt = sentThisSecond < MAX_PER_SECOND ? now : secondStart + 1000
  return Math.max(tokenAt, slotAt)
}

/** When does this signature WANT to go out (ignoring the budget)? null = nothing to say. */
function dueAt(s: Sig, force: boolean): number | null {
  if (s.first) return 0
  if (s.pending === 0) return null
  return force ? 0 : s.lastSentAt + REPEAT_EVERY_MS
}

function send(body: Payload): void {
  apiBeacon('/api/diag/client-error', body, 'POST')
}

function repeatPayload(s: Sig): Payload {
  return {
    kind: s.kind,
    message: s.message,
    path: currentPath(),
    build: build(),
    ...(s.surface ? { surface: s.surface } : {}),
    repeat: s.pending,
    since: new Date(s.pendingSince).toISOString(),
    last: new Date(s.pendingLast).toISOString(),
  }
}

/** Send whatever is due and affordable; re-arm the timer for the rest. `force` = the page is
 *  going away, so a repeat counter need not wait out its minute (the budget still applies). */
function pump(force = false): void {
  const now = Date.now()
  let wake = Infinity
  for (const s of sigs.values()) {
    const due = dueAt(s, force)
    if (due === null) continue
    if (due > now) { wake = Math.min(wake, due); continue }
    if (!spend(now)) { wake = Math.min(wake, nextSpendAt(now)); continue }
    if (s.first) {
      send(s.first)
      s.first = null
    } else {
      send(repeatPayload(s))
      s.pending = 0
    }
    s.lastSentAt = now
  }
  if (timer !== null) { clearTimeout(timer); timer = null }
  if (wake !== Infinity) timer = setTimeout(() => { timer = null; pump() }, Math.max(0, wake - now))
}

/** The fetch failure each engine throws when the network is gone (Chromium, Safari, Firefox). */
const NETWORK_FAILURE = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/

/**
 * A fetch that failed while the browser itself says it is offline is not a client error; it is the
 * device being offline, which the app already shows (24.09.2026). On an offline tablet the Karte's
 * basemap tiles fail one by one, and MapView reported each as «error: Failed to fetch». That is
 * noise in the post-Einsatz check, where every `kpfront.clienterror` line should be something
 * that broke. Deliberately narrow: only the bare network failure of an `error`/`unhandledrejection`,
 * and only while `navigator.onLine` is false. A render throw is never noise. A dead WLAN the
 * browser still calls online keeps reporting, because there the failure IS news.
 */
export function isOfflineNetworkNoise(kind: ErrorKind, message: string, onLine: boolean): boolean {
  return !onLine && (kind === 'error' || kind === 'unhandledrejection') && NETWORK_FAILURE.test(message)
}

export function reportClientError(err: unknown, ctx: Ctx = {}): void {
  try {
    const kind = ctx.kind ?? 'error'
    const message = (err instanceof Error ? err.message : String(err ?? 'unknown')).slice(0, MAX_MESSAGE)
    if (isOfflineNetworkNoise(kind, message, typeof navigator === 'undefined' || navigator.onLine !== false)) return
    const stack = err instanceof Error ? err.stack?.slice(0, MAX_STACK) : undefined
    const componentStack = ctx.componentStack?.slice(0, MAX_COMPONENT_STACK)
    const key = [kind, ctx.surface ?? '', message, stack?.slice(0, 200) ?? '', componentStack?.trim().slice(0, 200) ?? ''].join('|')
    const now = Date.now()
    const known = sigs.get(key) ?? (sigs.size >= MAX_SIGNATURES ? sigs.get(OVERFLOW_KEY) : undefined)
    if (known) {
      if (known.pending === 0) known.pendingSince = now
      known.pending += 1
      known.pendingLast = now
    } else if (sigs.size >= MAX_SIGNATURES) {
      // one row more than the cap: «and this many other distinct errors», counted like a repeat
      sigs.set(OVERFLOW_KEY, {
        first: null, kind: 'error', message: `weitere Fehlersignaturen (über ${MAX_SIGNATURES})`,
        pending: 1, pendingSince: now, pendingLast: now, lastSentAt: 0,
      })
    } else {
      sigs.set(key, {
        first: {
          kind, message, stack, componentStack, path: currentPath(), build: build(),
          ...(ctx.surface ? { surface: ctx.surface } : {}),
        },
        kind, message, surface: ctx.surface,
        pending: 0, pendingSince: 0, pendingLast: 0, lastSentAt: 0,
      })
    }
    pump()
  } catch { /* diagnostics must never throw */ }
}

/** The page is going away: send every counter that is still waiting, budget permitting. */
export function flushClientErrors(): void {
  try { pump(true) } catch { /* diagnostics must never throw */ }
}

/** Catch errors that escape React (async handlers, event listeners, rejected promises). The
 *  ErrorBoundary covers render throws; these two cover everything outside the render tree. */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (e) => reportClientError(e.error ?? e.message, { kind: 'error' }))
  window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason, { kind: 'unhandledrejection' }))
  // `pagehide`, not `beforeunload`: the one that fires on iOS when an installed app is swiped
  // away, and the one that does not spoil the back/forward cache
  window.addEventListener('pagehide', flushClientErrors)
}

/** Test-only: a fresh page load. */
export function __resetClientErrorsForTests(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  sigs = new Map()
  tokens = BUDGET_BURST
  refilledAt = -1
  secondStart = 0
  sentThisSecond = 0
}
