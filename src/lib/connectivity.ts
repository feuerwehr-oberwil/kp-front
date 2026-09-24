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
