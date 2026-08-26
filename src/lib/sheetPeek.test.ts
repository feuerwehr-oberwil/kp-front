// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { beginSheetPeek, endSheetPeek, sheetPeeked } from './sheetPeek'

// The phone detail sheet gets out of the way while an object is dragged (see lib/sheetPeek).
// What matters here is the state machine, not the pixels: the flag goes on when a drag starts
// moving, comes off on every way a drag can end — and can never get stuck on.

afterEach(() => endSheetPeek())

describe('sheetPeek', () => {
  it('marks the body while a drag is running and clears it on drop', () => {
    expect(sheetPeeked()).toBe(false)
    beginSheetPeek()
    expect(document.body.classList.contains('sheet-peek')).toBe(true)
    endSheetPeek()
    expect(document.body.classList.contains('sheet-peek')).toBe(false)
  })

  it('survives repeated begins and ends (one gesture reports many moves)', () => {
    beginSheetPeek()
    beginSheetPeek()
    beginSheetPeek()
    endSheetPeek()
    expect(sheetPeeked()).toBe(false)
    endSheetPeek() // a second end must not re-arm or throw
    expect(sheetPeeked()).toBe(false)
  })

  it('releases on its own when the gesture ends without an end handler', () => {
    // component unmounted mid-drag / the OS took the pointer: the window release is the
    // safety net that keeps the sheet from staying collapsed forever
    for (const type of ['pointerup', 'pointercancel'] as const) {
      beginSheetPeek()
      window.dispatchEvent(new Event(type))
      expect(sheetPeeked()).toBe(false)
    }
    beginSheetPeek()
    window.dispatchEvent(new Event('blur'))
    expect(sheetPeeked()).toBe(false)
  })
})
