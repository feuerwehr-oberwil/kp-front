// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('./installPrompt', () => ({ getInstallPlatform: () => 'android', isStandalone: () => false }))
const { locateFailedText, micFailedText, permissionPath, permissionPlace } = await import('./permissionPath')
const { appConfig } = await import('../config/appConfig')
const T = appConfig.copy.toast

// Rare-user round F9 (17.11.2026): a permission denied long ago names where its switch is on
// THIS platform, and «Mein Standort» never does nothing.
describe('permissionPath', () => {
  it('tells the installed iPhone app from a Safari tab, Android, and the desktop browsers', () => {
    expect(permissionPlace('ios', true)).toBe('iosApp')
    expect(permissionPlace('ios', false)).toBe('iosSafari')
    expect(permissionPlace('android', true)).toBe('android')
    for (const p of ['desktop-chromium', 'mac-safari', 'unsupported'] as const) expect(permissionPlace(p, false)).toBe('desktop')
  })

  it('names the app where the OS lists it by name', () => {
    expect(permissionPath('notifications', 'iosApp')).toContain('KP Front')
    expect(permissionPath('notifications', 'iosApp')).not.toContain('{app}')
  })

  it('«Mein Standort»: blocked names the path, anything else says try again', () => {
    expect(locateFailedText({ code: 1 } as GeolocationPositionError)).toBe(T.locateBlocked.replace('{path}', T.permissionPath.location.android))
    expect(locateFailedText({ code: 3 } as GeolocationPositionError)).toBe(T.locateNone)
    expect(locateFailedText(null)).toBe(T.locateNone)
  })

  it('the microphone: blocked names the path, a missing microphone keeps its sentence', () => {
    expect(micFailedText(new DOMException('no', 'NotAllowedError'))).toBe(T.micBlocked.replace('{path}', T.permissionPath.microphone.android))
    expect(micFailedText(new DOMException('no', 'NotFoundError'))).toBe(T.micDenied)
  })
})
