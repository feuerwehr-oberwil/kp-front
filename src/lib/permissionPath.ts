// Where a permission denied long ago is switched back on (rare-user round F9, 17.11.2026;
// RECOVERY.5 / ENTRY.6). «In den Browser-Einstellungen erlauben» names a place an installed iPhone
// app has no way to: the switch lives somewhere else on every platform, and the app knows which
// one it runs on – the split the InstallGuide and the readiness card already make
// (lib/installPolicy · InstallPlatform, lib/installPrompt · isStandalone). Four places: the
// installed iPhone app, a Safari tab, Android (Chrome, tab or app), and a desktop browser.
// The OS menu names are copy (copy.toast.permissionPath) – checked against the docs, not on
// every device; a renamed menu is a copy fix.
// Callers: «Mein Standort» (MapView, karte/useKarteCamera), the wizard's «Hier», «Standort
// teilen», the voice memo, and the readiness card's «Benachrichtigung» row.
import { appConfig } from '../config/appConfig'
import { deploymentName } from './deploymentConfig'
import { fillTemplate } from './format'
import { getInstallPlatform, isStandalone } from './installPrompt'
import type { InstallPlatform } from './installPolicy'

export type PermissionKind = 'location' | 'microphone' | 'notifications'
export type PermissionPlace = 'iosApp' | 'iosSafari' | 'android' | 'desktop'

export function permissionPlace(platform: InstallPlatform, standalone: boolean): PermissionPlace {
  if (platform === 'ios') return standalone ? 'iosApp' : 'iosSafari'
  return platform === 'android' ? 'android' : 'desktop'
}

/** The path to `kind`'s switch on this device («Safari «aA» › Website-Einstellungen › Standort»). */
export function permissionPath(kind: PermissionKind, place = permissionPlace(getInstallPlatform(), isStandalone())): string {
  return fillTemplate(appConfig.copy.toast.permissionPath[kind][place], { app: deploymentName() })
}

/** «Standort gesperrt – erlauben unter …» */
export const locateBlockedText = (): string => fillTemplate(appConfig.copy.toast.locateBlocked, { path: permissionPath('location') })

/** What a failed «Mein Standort» says: blocked → where to allow it; anything else (no fix in
 *  time, no GPS) → try again. Never nothing (a menu row that closes and does nothing reads broken). */
export function locateFailedText(err: GeolocationPositionError | null): string {
  return err?.code === 1 /* PERMISSION_DENIED */ ? locateBlockedText() : appConfig.copy.toast.locateNone
}

/** What a refused microphone says: blocked (NotAllowedError) → where to allow it; anything else
 *  (no microphone at all) keeps the old sentence. */
export function micFailedText(e: unknown): string {
  const T = appConfig.copy.toast
  return e instanceof DOMException && e.name === 'NotAllowedError' ? fillTemplate(T.micBlocked, { path: permissionPath('microphone') }) : T.micDenied
}
