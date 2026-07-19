import { apiBeacon } from './api'
import { APP_VERSION, GIT_SHA } from './buildInfo'

// Surface uncaught frontend errors to the server log so a solo operator's silent crash is
// visible to the deployer — the ErrorBoundary otherwise only console.errors, which nobody sees
// on a tablet in the field. Fire-and-forget (keepalive beacon), session-capped, and deduped so
// a render loop can't flood the log. This must NEVER throw: a diagnostics path that errors is
// worse than no diagnostics.
const MAX_REPORTS = 20 // per session — a wedged app shouldn't spam the server log
const seen = new Set<string>()
let sent = 0

export type ErrorKind = 'render' | 'error' | 'unhandledrejection'

export function reportClientError(err: unknown, ctx: { kind?: ErrorKind; componentStack?: string } = {}): void {
  try {
    if (sent >= MAX_REPORTS) return
    const kind = ctx.kind ?? 'error'
    const message = (err instanceof Error ? err.message : String(err ?? 'unknown')).slice(0, 2000)
    const stack = err instanceof Error ? err.stack?.slice(0, 8000) : undefined
    // Dedupe on kind + message + the stack head so the same throw firing repeatedly is logged once.
    const key = `${kind}|${message}|${stack?.slice(0, 200) ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    sent++
    apiBeacon('/api/diag/client-error', {
      kind,
      message,
      stack,
      componentStack: ctx.componentStack?.slice(0, 8000),
      path: location.pathname.slice(0, 400),
      build: `v${APP_VERSION}+${GIT_SHA}`,
    }, 'POST')
  } catch { /* diagnostics must never throw */ }
}

/** Catch errors that escape React (async handlers, event listeners, rejected promises). The
 *  ErrorBoundary covers render throws; these two cover everything outside the render tree. */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (e) => reportClientError(e.error ?? e.message, { kind: 'error' }))
  window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason, { kind: 'unhandledrejection' }))
}
