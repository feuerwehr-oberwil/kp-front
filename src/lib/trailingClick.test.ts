// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { trailingClickGuard } from './trailingClick'

const pointerDown = () => window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

// A hold-delete on a node acts mid-gesture, so the map click its release may leave is swallowed
// (MapView · handleClick). Only THAT click: the next tap is a new gesture and the map's again.
describe('trailingClickGuard', () => {
  it('swallows the click that trails the gesture which armed it, once', () => {
    const guard = trailingClickGuard()
    guard.arm()
    expect(guard.take()).toBe(true)
    expect(guard.take()).toBe(false)
  })

  // ⚠️ A touch long-press often leaves no click at all, nor does the right-click delete: the flag
  // waited for one and ate the next real tap (Üben round 4, 24.11.2026 – a point would not place).
  it('lets the next gesture’s click through when the hold left none', () => {
    const guard = trailingClickGuard()
    guard.arm()
    pointerDown()
    expect(guard.take()).toBe(false)
  })
})
