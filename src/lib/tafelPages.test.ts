// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SKIZZE, resetTafelPageMemory, stepPage, useTafelPage } from './tafelPages'
import { readFileSync } from 'node:fs'
import { SIDE_INSET_L } from './whiteboard'

describe('which Tafel page this device has open', () => {
  it('is remembered per Einsatz across a reload (IndexedDB), never shared', async () => {
    resetTafelPageMemory()
    const a = renderHook(() => useTafelPage('inc-1'))
    expect(a.result.current[0]).toBe(SKIZZE)
    act(() => a.result.current[1]('fm-ef'))
    expect(a.result.current[0]).toBe('fm-ef')
    a.unmount()
    // a reload: the session memory is gone, the device's store is not
    resetTafelPageMemory()
    const b = renderHook(() => useTafelPage('inc-1'))
    await waitFor(() => expect(b.result.current[0]).toBe('fm-ef'))
    // another Einsatz starts on the Skizze
    const c = renderHook(() => useTafelPage('inc-2'))
    expect(c.result.current[0]).toBe(SKIZZE)
  })
  it('PageUp / PageDown stop at the ends', () => {
    expect([stepPage(['s', 'a', 'b'], 'a', 1), stepPage(['s', 'a', 'b'], 'b', 1), stepPage(['s', 'a'], 's', -1)]).toEqual(['b', 'b', 's'])
  })
})

/* owner, staging (2eac58d9, ~900 wide): the strip stood at the screen's left edge under the top
 * bar and the nav rail, centred in its band, reached up into it — «›» on «Skizze». Beside a rail
 * the strip starts where the board starts, right of the rail, whatever the rail's width. */
describe('the page strip never stands on the nav rail', () => {
  const css = readFileSync(`${process.cwd()}/src/styles/09-whiteboard.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
  it('starts right of the rail (16 + rail width + 12, the board\'s SIDE_INSET_L) and follows a labelled rail', () => {
    const tps = rule('.tps')
    expect(tps).toMatch(/left:\s*var\(--tps-l\)/)
    expect(tps).toMatch(/--tps-l:\s*calc\(max\(16px, env\(safe-area-inset-left\)\) \+ var\(--rail-w\) \+ 12px\)/)
    expect(css).toMatch(/:root:has\(\.navrail\.labelled:not\(\.expanded\):not\(\.dragging\)\) \.tps \{ --tps-l: [^}]*--rail-w-labelled/)
    expect(16 + 60 + 12).toBe(SIDE_INSET_L)
  })
  it('on a phone (no side rails) it keeps the screen edge', () => {
    const phone = css.slice(css.indexOf('@media (--phone)', css.indexOf('.tps {')))
    expect(phone.slice(0, 200)).toMatch(/\.tps \{ --tps-l: max\(16px, env\(safe-area-inset-left\)\)/)
  })
})
