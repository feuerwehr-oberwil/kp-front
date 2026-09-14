// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { dismissNearbyBanner, nearbyBannerDismissed, nearbyBannerKey } from './nearbyBanner'

// jsdom exposes localStorage as a getter-only accessor here – install the same minimal stub the
// ErrorBoundary/LoginScreen tests use.
function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size },
    } as Storage,
  })
}

describe('the nearby-object banner is dismissed once per Einsatz and object', () => {
  beforeEach(installLocalStorage)

  it('is not dismissed until ✕, and only for that key', () => {
    const key = nearbyBannerKey('inc1', 'obj1')
    expect(nearbyBannerDismissed(key)).toBe(false)
    dismissNearbyBanner(key)
    expect(nearbyBannerDismissed(key)).toBe(true)
    expect(nearbyBannerDismissed(nearbyBannerKey('inc2', 'obj1'))).toBe(false)
  })

  it('keeps at most 50 keys', () => {
    for (let i = 0; i < 60; i++) dismissNearbyBanner(`inc${i}:o`)
    expect(nearbyBannerDismissed('inc0:o')).toBe(false)
    expect(nearbyBannerDismissed('inc59:o')).toBe(true)
  })
})
