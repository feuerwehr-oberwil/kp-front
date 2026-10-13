// The device's own position as a photo's place — for the pictures that do not carry one.
//
// Why (owner, 09.10.2026: «position is good enough»): an iPhone's in-app camera NEVER hands a web
// page a GPS fix — WebKit strips it from every shot taken through `<input capture>` (lib/exif ·
// header). So a photo taken in KP Front, the commonest photo of all, had no place to go on the
// Karte. Where a picture has no EXIF position, the device's own position at the moment it
// arrives stands in for it: POSITION ONLY — no compass, so no view cone — and only:
//
//   · when the operator said yes ONCE, on this device, to a question that says why
//     (`photoPositionGate` → 'ask' → the confirm in IncidentWorkspace). The answer is a device
//     preference (lib/prefs · photoPosition) and the Einstellungen sheet switches it back;
//   · when the picture was taken NOW (`takenRecently`): a library photo from last week, read
//     while standing at the Einsatz, must not be placed where the operator stands today;
//   · when the fix is good enough to place a marker by (`MAX_ACCURACY_M`);
//   · and — like an EXIF position — only inside the Einsatz radius (lib/photoGeo · rowGeoFor).
//
// It fails SILENTLY everywhere: no geolocation, permission denied, offline without a fix, a
// timeout — the photo simply has no position, exactly as before. Never a toast, never a retry.

import type { PhotoGeo } from '../types'

/** A fix worse than this cannot put a marker anywhere useful (a cell-tower guess). */
export const MAX_ACCURACY_M = 250
/** How long a fix may take. The row is written without waiting; this bounds the late patch. */
export const FIX_TIMEOUT_MS = 15_000
/** A fix this young is as good as a fresh one — the operator has not moved since. */
export const FIX_MAX_AGE_MS = 60_000
/** A picture older than this (by its EXIF time or the file's date) was not taken just now. */
export const RECENT_MS = 15 * 60_000

export type GeoPermission = PermissionState | 'unsupported' | 'unavailable'

/** What may be done for a picture without an EXIF position: use the device, ask first, or nothing. */
export function photoPositionGate(pref: boolean | undefined, permission: GeoPermission): 'use' | 'ask' | 'off' {
  if (permission === 'unavailable' || permission === 'denied') return 'off'
  if (pref === false) return 'off'
  // ⚠️ ASKED even when the browser already grants geolocation (for «Standort teilen», say):
  // keeping a position with a photo is a different use, and the operator agrees to it once.
  if (pref === undefined) return 'ask'
  return 'use'
}

/** The browser's word on geolocation, without prompting. `unavailable` = no geolocation at all
 *  (an insecure origin, an old browser); `unsupported` = no Permissions API to ask (older Safari). */
export async function geoPermission(nav: Navigator = navigator): Promise<GeoPermission> {
  if (!nav || !('geolocation' in nav) || !nav.geolocation) return 'unavailable'
  try {
    if (!nav.permissions?.query) return 'unsupported'
    return (await nav.permissions.query({ name: 'geolocation' as PermissionName })).state
  } catch {
    return 'unsupported'
  }
}

export interface DeviceFix { lat: number; lng: number; acc: number; at: number }

/** One fix, or `null` on any refusal, error or timeout. Never rejects. */
export function currentFix(nav: Navigator = navigator): Promise<DeviceFix | null> {
  return new Promise((resolve) => {
    if (!nav?.geolocation) { resolve(null); return }
    let done = false
    const finish = (v: DeviceFix | null) => { if (!done) { done = true; resolve(v) } }
    // the browser's own timeout does not count the time a permission prompt stands open
    const guard = setTimeout(() => finish(null), FIX_TIMEOUT_MS + 30_000)
    try {
      nav.geolocation.getCurrentPosition(
        (p) => { clearTimeout(guard); finish({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: p.timestamp || Date.now() }) },
        () => { clearTimeout(guard); finish(null) },
        { enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: FIX_MAX_AGE_MS },
      )
    } catch {
      clearTimeout(guard); finish(null)
    }
  })
}

/**
 * Was this picture taken just now? Its EXIF time decides when it has one (a time without an
 * offset is the camera's local time); otherwise the file's own date. Neither → yes: a camera
 * shot handed over without metadata is exactly the case this exists for.
 */
export function takenRecently(file: { lastModified?: number }, takenAt: string | undefined, now = Date.now()): boolean {
  if (takenAt) {
    const t = Date.parse(takenAt)
    if (Number.isFinite(t)) return Math.abs(now - t) <= RECENT_MS
  }
  if (typeof file.lastModified === 'number' && file.lastModified > 0) return Math.abs(now - file.lastModified) <= RECENT_MS
  return true
}

/** A fix as a photo's recorded place — `null` when it is too coarse to place anything by. */
export function fixToPhotoGeo(fix: DeviceFix | null): PhotoGeo | null {
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return null
  if (!(fix.acc <= MAX_ACCURACY_M)) return null
  const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d
  return { lat: r(fix.lat, 7), lng: r(fix.lng, 7), acc: Math.max(1, Math.round(fix.acc)), takenAt: localIso(fix.at), source: 'device' }
}

/** «2026-10-09T14:32:05+02:00» — the device's local clock with its offset, the shape an EXIF
 *  time with an offset has, so the record reads the same either way. */
export function localIso(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`
}

/**
 * The device source the workspace registers (lib/photoGeo · setDevicePositionSource): the gate,
 * the one question, the fix. Deps injected so the whole decision is testable without a browser.
 * Several pictures at once ask ONCE — the question in flight is shared.
 */
export function makePhotoPositionSource(deps: {
  nav?: Navigator
  /** the device preference: undefined = never asked (lib/prefs · photoPosition) */
  loadPref: () => boolean | undefined
  savePref: (v: boolean) => void
  /** the question, with its reason — true = yes */
  ask: () => Promise<boolean>
}): () => Promise<PhotoGeo | null> {
  let asking: Promise<boolean> | null = null
  return async () => {
    const nav = deps.nav ?? navigator
    const gate = photoPositionGate(deps.loadPref(), await geoPermission(nav))
    if (gate === 'off') return null
    if (gate === 'ask') {
      asking ??= deps.ask().then((yes) => { deps.savePref(yes); return yes }, () => false).finally(() => { asking = null })
      if (!(await asking)) return null
    }
    return fixToPhotoGeo(await currentFix(nav))
  }
}
