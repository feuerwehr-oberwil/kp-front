// Imported into the workbox-generated service worker (vite.config workbox.importScripts).
// Handles taps on system notifications: focus the existing app window (or open one) and tell
// the page which tab to show via postMessage. Without this, tapping a PWA notification did
// nothing — it didn't even bring the app to the front.
// Server Web Push (killed-app alarms: Atemschutz überfällig, Wiedervorlage fällig). The
// backend sends {title, body, tag, target}; the tag matches the in-app notification's tag
// so a foregrounded app's own notification and the push coalesce into one tray entry.
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { /* non-JSON push — show generic */ }
  const title = data.title || 'KP Front'
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || 'kp-front',
    renotify: true,
    data: { target: data.target || null },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.target) || null
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    let client = all.find((c) => 'focus' in c) || null
    if (client) {
      try { await client.focus() } catch { /* focus can reject if not allowed */ }
      if (target) client.postMessage({ type: 'kp-notification-click', target })
    } else {
      // Cold start (app was killed — the case server push exists for): a postMessage would
      // arrive before the page mounts its listener and be lost, so carry the target in the
      // URL instead; the app consumes ?kpn= once at boot (src/lib/notifyTarget.ts).
      await self.clients.openWindow(target ? '/?kpn=' + encodeURIComponent(target) : '/')
    }
  })())
})
