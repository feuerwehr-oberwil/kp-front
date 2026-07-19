import { apiGet, apiPost } from './api'

/**
 * Web-Push subscription (killed-app alarms). The in-app alarm layer covers a foregrounded
 * PWA; the server push covers a swiped-away / OS-reclaimed one. Best-effort by design:
 * subscribe whenever (a) the deployment has VAPID keys, (b) the browser supports push,
 * and (c) notification permission is already granted — permission itself is only ever
 * requested from a user gesture (ensureNotifyPermission), never here.
 */

function b64ToUint8(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

let attempted = false

/** Idempotent per session; call after login and again after a permission grant. */
export async function ensurePushSubscription(force = false): Promise<boolean> {
  if (attempted && !force) return false
  attempted = true
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
    const { key } = await apiGet<{ key: string | null; enabled: boolean }>('/api/push/vapid-key')
    if (!key) return false // deployment has no VAPID keys — push disabled
    const reg = await navigator.serviceWorker.ready
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToUint8(key).buffer as ArrayBuffer,
      }))
    const json = sub.toJSON()
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false
    await apiPost('/api/push/subscriptions', { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } })
    return true
  } catch {
    return false // never let push plumbing break the app
  }
}
