// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lockChromeZoom } from './lockZoom'

const listenedTypes = () => vi.mocked(document.addEventListener).mock.calls.map((c) => c[0])
const withTouchPoints = (n: number) => Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => n })

afterEach(() => { vi.restoreAllMocks(); window.history.pushState({}, '', '/') })

describe('lockChromeZoom', () => {
  it('blocks the iOS pinch gestures on the chrome of a touch device', () => {
    withTouchPoints(5)
    vi.spyOn(document, 'addEventListener')
    lockChromeZoom()
    expect(listenedTypes()).toEqual(['gesturestart', 'gesturechange', 'gestureend', 'touchmove'])
  })

  it('leaves a trackpad pinch alone where there is no touch (macOS Safari) — keeping the touchmove guard', () => {
    withTouchPoints(0)
    vi.spyOn(document, 'addEventListener')
    lockChromeZoom()
    expect(listenedTypes()).toEqual(['touchmove'])
  })

  it('leaves /admin zoomable even on a touch device', () => {
    withTouchPoints(5)
    window.history.pushState({}, '', '/admin/config')
    vi.spyOn(document, 'addEventListener')
    lockChromeZoom()
    expect(listenedTypes()).toEqual(['touchmove'])
  })
})
