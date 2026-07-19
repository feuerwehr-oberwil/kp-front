import { describe, expect, it } from 'vitest'
import { detectInstallPlatform, shouldShowInstallBanner } from './installPolicy'

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  // iPadOS Safari reports a macOS UA — only maxTouchPoints reveals the tablet
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.61',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
}

describe('detectInstallPlatform', () => {
  it('iPhone Safari → ios', () => {
    expect(detectInstallPlatform(UA.iphoneSafari)).toBe('ios')
  })

  it('Chrome on iOS installs via the same share sheet → ios', () => {
    expect(detectInstallPlatform(UA.iphoneChrome)).toBe('ios')
  })

  it('iPadOS Safari with macOS UA is unmasked by touch points → ios', () => {
    expect(detectInstallPlatform(UA.ipadDesktopMode, 5)).toBe('ios')
  })

  it('the same macOS UA without touch is real desktop Safari → mac-safari', () => {
    expect(detectInstallPlatform(UA.macSafari, 0)).toBe('mac-safari')
  })

  it('Android → android (any browser; the guide notes non-Chrome wording)', () => {
    expect(detectInstallPlatform(UA.androidChrome)).toBe('android')
    expect(detectInstallPlatform(UA.androidFirefox)).toBe('android')
  })

  it('desktop Chrome and Edge → desktop-chromium', () => {
    expect(detectInstallPlatform(UA.winChrome)).toBe('desktop-chromium')
    expect(detectInstallPlatform(UA.winEdge)).toBe('desktop-chromium')
  })

  it('desktop Firefox has no PWA install → unsupported', () => {
    expect(detectInstallPlatform(UA.winFirefox)).toBe('unsupported')
  })
})

describe('shouldShowInstallBanner', () => {
  it('shows in a plain browser tab on an installable platform', () => {
    expect(shouldShowInstallBanner({ standalone: false, dismissed: false, platform: 'ios' })).toBe(true)
  })

  it('never when already running installed (standalone)', () => {
    expect(shouldShowInstallBanner({ standalone: true, dismissed: false, platform: 'ios' })).toBe(false)
  })

  it('never again once dismissed on this device (no re-nagging)', () => {
    expect(shouldShowInstallBanner({ standalone: false, dismissed: true, platform: 'android' })).toBe(false)
  })

  it('never where there is no install path to point at', () => {
    expect(shouldShowInstallBanner({ standalone: false, dismissed: false, platform: 'unsupported' })).toBe(false)
  })

  it('never on desktop — the app form only matters on mobile (2026-07-14)', () => {
    expect(shouldShowInstallBanner({ standalone: false, dismissed: false, platform: 'desktop-chromium' })).toBe(false)
    expect(shouldShowInstallBanner({ standalone: false, dismissed: false, platform: 'mac-safari' })).toBe(false)
  })
})
