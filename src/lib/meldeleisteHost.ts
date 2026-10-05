/**
 * Where the Meldeleiste paints: inside the open Einsatz's `.app`, or at App root when none is open.
 *
 * ⚠️ The strip's z-index (54, UNDER the top bar's 56 and every menu/popover/drawer above it —
 * 01-tokens) only means anything inside the SAME stacking context. `.app` is `position: fixed`,
 * which always makes one, so a strip mounted beside it at App root was compared with `.app` as a
 * whole — and painted over EVERYTHING in it: at 820 the «Atemschutz überfällig» row lay over the
 * open Einsatz menu's own card, and a tap on the card landed on «Zum Trupp» (staging r5, N3).
 * The strip stays mounted at App root (it has to exist with no Einsatz open — App.tsx), and
 * PORTALS into the workspace's `.app` while there is one, so the ladder the tokens describe is
 * the one the browser uses.
 */
type Listener = () => void

let host: HTMLElement | null = null
const listeners = new Set<Listener>()
const notify = () => { for (const fn of listeners) fn() }

/**
 * The ref callback for the workspace's `.app` element (React 19 ref with cleanup): registers it,
 * and lets go of exactly THAT element when it unmounts — a second workspace mounting before the
 * first one's cleanup ran keeps its registration.
 */
export function registerMeldeleisteHost(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined
  host = el
  notify()
  return () => {
    if (host !== el) return
    host = null
    notify()
  }
}

export function getMeldeleisteHost(): HTMLElement | null {
  return host
}

export function subscribeMeldeleisteHost(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
