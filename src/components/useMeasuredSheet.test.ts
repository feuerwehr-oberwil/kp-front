// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMeasuredSheet } from './useMeasuredSheet'

/* ⚠️ THE BUG this hook exists as one piece for. The two pieces of state were separate and the
 * certificate was stamped on the Modul SLOT (`activeId`), which every Einsatzobjekt shares. On an
 * object switch the slot id does not change — so the seed never ran, the PDF viewport (keyed on
 * the slot too) did not remount, and building A's measured shape stayed both in `aspect` and
 * certified. It was then written into the station document as building B's measured aspect:
 * persisted, shared with every device, blocking B's real measurement for the session, and
 * re-baking B's sheet onto wrong ground under a Verlauf row claiming its reference was corrected. */

const A4_PORTRAIT = 1.414
const A4_LANDSCAPE = 1 / 1.414

const sheet = (georefKey: string, orientation: 'portrait' | 'landscape' = 'portrait') =>
  renderHook(({ k, o }: { k: string; o: 'portrait' | 'landscape' }) => useMeasuredSheet(k, o), {
    initialProps: { k: georefKey, o: orientation },
  })

describe('useMeasuredSheet', () => {
  it('starts at the A4 the plan claims to be, and says so is not a measurement', () => {
    const { result } = sheet('object:a:plan:modul2')
    expect(result.current.aspect).toBeCloseTo(A4_PORTRAIT, 6)
    expect(result.current.measured).toBe(false)
    expect(sheet('object:a:plan:modul2', 'landscape').result.current.aspect).toBeCloseTo(A4_LANDSCAPE, 6)
  })

  it('a viewport that rendered the bitmap certifies the number', () => {
    const { result } = sheet('object:a:plan:modul2')
    act(() => result.current.takeAspect(1.2))
    expect(result.current.aspect).toBe(1.2)
    expect(result.current.measured).toBe(true)
  })

  it('an OBJECT SWITCH invalidates the certificate — same Modul slot, different paper', () => {
    // the plan id is «modul2» on both sides of this switch; only the sheet key changes
    const h = sheet('object:a:plan:modul2')
    act(() => h.result.current.takeAspect(1.2))
    h.rerender({ k: 'object:b:plan:modul2', o: 'portrait' })

    expect(h.result.current.measured).toBe(false)      // nothing has looked at B's bitmap
    expect(h.result.current.aspect).toBeCloseTo(A4_PORTRAIT, 6) // …and A's shape did not come along
  })

  it('…and B’s own viewport then certifies B, not A', () => {
    const h = sheet('object:a:plan:modul2')
    act(() => h.result.current.takeAspect(1.2))
    h.rerender({ k: 'object:b:plan:modul2', o: 'portrait' })
    act(() => h.result.current.takeAspect(0.8))
    expect(h.result.current.aspect).toBe(0.8)
    expect(h.result.current.measured).toBe(true)
  })

  it('a plan switch within the same object invalidates it too', () => {
    const h = sheet('object:a:plan:modul2')
    act(() => h.result.current.takeAspect(1.2))
    h.rerender({ k: 'object:a:plan:modul3', o: 'landscape' })
    expect(h.result.current.measured).toBe(false)
    expect(h.result.current.aspect).toBeCloseTo(A4_LANDSCAPE, 6)
  })
})
