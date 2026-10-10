// Is the server reachable — as far as this device can tell without asking twice?
//
// The browser's `online`/`offline` events are a hint about the LINK, not about reach, and they
// are missed in exactly the cases that matter in the field (24.09.2026, #209): a WLAN that is up
// but routes nowhere, a backend restart behind the proxy, a reload while offline after which the
// `online` event never comes. `navigator.onLine` then never moves, and a surface that trusted
// only the events said «Offline» long after every request was succeeding again.
//
// So the fetch wrapper (api · rawFetch) reports what it SAW, and this module keeps two facts:
//   · `isOnline()` — the indicator. The `offline` event is still the only thing that turns it
//     off (a failed request does not: a timeout on one route is not «offline», and flipping on
//     every failure would make it flap). The `online` event AND any fresh successful answer from
//     our own server turn it back on.
//   · `onReachable` — «the server answered again after this device last failed to reach it»: an
//     `offline` event, or a request that failed on the network / got a 502·503·504 from the proxy.
//     The outboxes (workspace, audit events) retry on it as they do on `online`, so a recovery the
//     browser never announced does not wait out their backoff. It fires once per recovery; an
//     offline device sees no answers and therefore no signal — nothing here polls.
//
// «Fresh» is serverClock's rule (`isFreshSampleSource`): a service-worker cache hit carries the
// status of the day it was stored and proves nothing about reach today.

/*
 * ⚠️ **Reconnect is proven by an answer, not by the `online` event** (24.09.2026, after #209).
 * A WLAN that routes nowhere, a backend restart, or a reload while offline never fires `online`.
 * So the fetch wrapper reports what it saw (`lib/connectivity`). Any FRESH successful answer
 * (`serverClock · isFreshSampleSource`, never a service-worker cache hit) turns `useOnline` back
 * on. Only the `offline` event turns it off: a failed request never does, so it cannot flap. The
 * first answer after a failure to reach the server (status 0 or 502/503/504, or an `offline`
 * event) fires `onReachable`, and the workspace and audit outboxes flush on it as on `online`.
 * A flush REQUESTED while an outbox attempt is in flight gets one more attempt if that attempt
 * failed to reach the server. Workspace and audit do this through the public `flush()`; the
 * journal has its own copy. The stores' own timers go through `run()` and request nothing. It is
 * one re-run per request and never after an answer (401, refused, exhausted merge), so an offline
 * device does not spin (`outboxReconnect.soak.test.ts`).
 */

let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false
/** a request failed to reach the server since the last answer (see `noteUnreached`) */
let unreached = !online
const listeners = new Set<() => void>()
const reachable = new Set<() => void>()

function setOnline(value: boolean) {
  if (online === value) return
  online = value
  for (const l of [...listeners]) l()
}

/** The indicator: false only between an `offline` event and the next sign of reach. */
export function isOnline(): boolean {
  return online
}

/** Subscribe to the indicator (useSyncExternalStore shape). */
export function subscribeOnline(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Called once the server answered again after this device last failed to reach it. */
export function onReachable(listener: () => void): () => void {
  reachable.add(listener)
  return () => { reachable.delete(listener) }
}

/** A fresh, successful answer from our own server (api · rawFetch). */
export function noteAnswered(): void {
  const recovered = unreached || !online
  unreached = false
  setOnline(true)
  if (recovered) for (const l of [...reachable]) l()
}

/** A request did not reach the server (network failure, our timeout, a 502/503/504 from the
 *  proxy). Deliberately does NOT touch the indicator — see the module header. */
export function noteUnreached(): void {
  unreached = true
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => setOnline(true))
  window.addEventListener('offline', () => { unreached = true; setOnline(false) })
}

/** Tests only: back to «online, nothing failed», listeners kept. */
export function resetConnectivityForTests(value = true): void {
  online = value
  unreached = !value
}
