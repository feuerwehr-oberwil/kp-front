// SPIKE «Üben» (19.11.2026): the seam. Wraps `window.fetch` and `navigator.sendBeacon` ONCE at
// boot (main.tsx), before any module sends a request: a request whose path names a practice
// incident (lib/practice/practiceMode — the current id or a retired one) is answered by
// lib/practice/localServer and never reaches the network or the service worker; everything else
// passes through untouched. Installed whenever a practice id exists, whether or not the mode is
// on — so no code path, however it got hold of the id, can send it to the server.
//
// What it cannot see: a request the BROWSER makes on its own — an `<img src>`, `<audio src>`, a
// CSS url(), a navigation. Practice media rendered that way would leak its URL (see the spike
// report); the app's media go through fetch + blob URLs today.

import { answerPractice, practiceTarget, type PracticeContext } from './localServer'
import { knownPracticeId, retiredPracticeIds } from './practiceMode'

let installed = false
let userId: string | null = null

/** The signed-in account, for the audit events the fake stamps (App sets it). */
export function setPracticeUser(id: string | null): void { userId = id }

function context(): PracticeContext | null {
  const id = knownPracticeId()
  const retired = retiredPracticeIds()
  if (!id && !retired.length) return null
  // a retired id with no current one: still refused here, never sent
  return { id: id ?? '', retired, userId }
}

const pathOf = (input: RequestInfo | URL): string => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try { return new URL(raw, window.location.href).pathname } catch { return '' }
}

export function installPracticeFetch(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const ctx = context()
    if (!ctx || !practiceTarget(pathOf(input), ctx)) return realFetch(input, init)
    const req = new Request(input, init)
    // a caller's abort/timeout still applies to a parked long poll
    if (req.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const res = await answerPractice(req, ctx)
    // spike: say what the fake refused — the list of what practice mode still lacks
    if (res.status >= 400) console.warn(`[practice] ${res.status} ${req.method} ${new URL(req.url).pathname}`)
    // …and an aborted one rejects like a real fetch, not with the 304 it was parked for
    if (req.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return res
  }
  const realBeacon = navigator.sendBeacon?.bind(navigator)
  if (realBeacon) {
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
      const ctx = context()
      if (!ctx || !practiceTarget(pathOf(url), ctx)) return realBeacon(url, data)
      void answerPractice(new Request(url, { method: 'POST', body: data ?? null }), ctx).catch(() => {})
      return true
    }
  }
}
