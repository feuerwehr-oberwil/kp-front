// @vitest-environment jsdom
// The Karte's scroll readout switch: five quick taps, `?debug=scroll`, sticky on the device.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DEBUG_TAPS, TAP_GAP_MS, scrollDebugOn, setScrollDebug, tapCounter } from './scrollDebug'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => window.history.replaceState(null, '', '/'))

describe('tapCounter', () => {
  it('fires on the fifth quick tap, then starts over', () => {
    let t = 0
    const tap = tapCounter(() => t)
    const fired = Array.from({ length: DEBUG_TAPS * 2 }, () => { t += 200; return tap() })
    expect(fired.map(Number).join('')).toBe('0000100001')
  })

  it('a pause longer than the gap starts the count again', () => {
    let t = 0
    const tap = tapCounter(() => t)
    for (let i = 0; i < DEBUG_TAPS - 1; i++) { t += 200; expect(tap()).toBe(false) }
    t += TAP_GAP_MS + 1
    expect(tap()).toBe(false)
    for (let i = 0; i < DEBUG_TAPS - 2; i++) { t += 200; expect(tap()).toBe(false) }
    t += 200
    expect(tap()).toBe(true)
  })
})

describe('the flag', () => {
  it('is off by default and sticky in localStorage once on', () => {
    expect(scrollDebugOn()).toBe(false)
    setScrollDebug(true)
    expect(scrollDebugOn()).toBe(true)
    expect(localStorage.getItem('kp.debug.scroll')).toBe('1')
    setScrollDebug(false)
    expect(scrollDebugOn()).toBe(false)
  })

  it('tells the readout when it flips', () => {
    const seen = vi.fn()
    window.addEventListener('kp-debug-scroll', seen)
    setScrollDebug(true)
    window.removeEventListener('kp-debug-scroll', seen)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('`?debug=scroll` switches it on, `?debug=off` off — the old tab flag too', () => {
    window.history.replaceState(null, '', '/karte?debug=scroll')
    expect(scrollDebugOn()).toBe(true)
    window.history.replaceState(null, '', '/karte')
    expect(scrollDebugOn()).toBe(true)
    sessionStorage.setItem('kp.debug.scroll', '1')
    window.history.replaceState(null, '', '/karte?debug=off')
    expect(scrollDebugOn()).toBe(false)
    expect(sessionStorage.getItem('kp.debug.scroll')).toBeNull()
  })
})
