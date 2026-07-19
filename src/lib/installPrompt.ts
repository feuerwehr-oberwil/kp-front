// "Als App installieren" plumbing. The app is a full PWA (offline shell, manifest, icons),
// but in a plain browser tab none of that is discoverable — this module detects browser-tab
// mode, captures Chromium's beforeinstallprompt so the guide can offer real one-tap install,
// and remembers the banner dismissal per device. Installed (standalone) the whole surface is
// invisible. UI: InstallBanner (the nudge) + InstallGuide (the platform-detected steps);
// pure decision rules live in installPolicy.ts (unit-tested).
import { detectInstallPlatform, shouldShowInstallBanner, type InstallPlatform } from './installPolicy'

// tiny per-device flag → localStorage by convention (like theme prefs / migration flags)
const DISMISSED_KEY = 'kp-install-dismissed'

// Chromium-only event; not in lib.dom because the spec never left incubation.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
let installed = false
const listeners = new Set<() => void>()
const notifyAll = () => { for (const cb of listeners) cb() }

/** Called once at boot (main.tsx), before React mounts — beforeinstallprompt can fire early
 *  and is lost if nothing is listening. */
export function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // suppress Chrome's own mini-infobar; the guide offers it in context
    deferred = e as BeforeInstallPromptEvent
    notifyAll()
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    deferred = null
    notifyAll()
  })
}

/** Already running as the installed app? (display-mode via manifest, or iOS's legacy flag) */
export function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || (navigator as { standalone?: boolean }).standalone === true
  } catch { return false }
}

export function getInstallPlatform(): InstallPlatform {
  return detectInstallPlatform(navigator.userAgent, navigator.maxTouchPoints)
}

/** Did the browser hand us a real install prompt (Chromium)? → guide shows one-tap install. */
export function canPromptNative(): boolean {
  return deferred != null
}

/** Was the app installed during THIS page life (appinstalled fired)? */
export function isInstalled(): boolean {
  return installed
}

/** Open the browser's native install dialog. One-shot: Chromium invalidates the event after
 *  use, so a dismissed dialog falls back to the written steps (still on screen). */
export async function promptNativeInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const ev = deferred
  if (!ev) return 'unavailable'
  deferred = null
  await ev.prompt()
  const choice = await ev.userChoice
  notifyAll()
  return choice.outcome
}

export function dismissInstallBanner() {
  try { localStorage.setItem(DISMISSED_KEY, '1') } catch { /* then it may re-show next visit */ }
  notifyAll()
}

export function shouldShowBanner(): boolean {
  let dismissed = true // storage unreadable (private mode) → be conservative, don't nag
  try { dismissed = localStorage.getItem(DISMISSED_KEY) === '1' } catch { /* see above */ }
  return shouldShowInstallBanner({
    standalone: isStandalone(),
    dismissed: dismissed || installed,
    platform: getInstallPlatform(),
  })
}

/** Subscribe to install-state changes (prompt captured, installed, banner dismissed) — the
 *  banner and the guide both re-render off this. Returns an unsubscribe. */
export function onInstallStateChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
