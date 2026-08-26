/** Keep the service worker's protected-media cache aligned with the current browser session.
 *
 * The worker deliberately treats an unknown client as network-only. We therefore resend the
 * current context once the active worker is ready and after controller changes, not just when
 * React's user changes. A waiting worker must never inherit permission by accident.
 */
type MediaCacheUser = { id: string; link_scoped?: boolean } | null

type MediaCacheContext =
  | { type: 'kp-media-auth'; kind: 'user'; userId: string }
  | { type: 'kp-media-auth'; kind: 'link' }
  | { type: 'kp-media-auth'; kind: 'logged-out' }

let current: MediaCacheContext | null = null
let listening = false

function serviceWorkerContainer(): ServiceWorkerContainer | null {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? navigator.serviceWorker
    : null
}

function postCurrent(target?: ServiceWorker | null): void {
  if (current && target) target.postMessage(current)
}

export function syncMediaCacheAuth(user: MediaCacheUser): void {
  current = user?.link_scoped
    ? { type: 'kp-media-auth', kind: 'link' }
    : user
      ? { type: 'kp-media-auth', kind: 'user', userId: user.id }
      : { type: 'kp-media-auth', kind: 'logged-out' }

  const sw = serviceWorkerContainer()
  if (!sw) return

  postCurrent(sw.controller)
  void sw.ready.then((registration) => postCurrent(registration.active)).catch(() => {})

  if (!listening) {
    listening = true
    sw.addEventListener('controllerchange', () => postCurrent(sw.controller))
  }
}
