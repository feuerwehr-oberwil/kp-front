// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SKIZZE, resetTafelPageMemory, stepPage, useTafelPage } from './tafelPages'
import { readFileSync } from 'node:fs'

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

/* owner, before the release: «move the skizze/führung thing to the same place where the location
 * change button is on the other pages». The strip stands in the plan's bottom-left row — where the
 * Objekt chip says «which place» — which already clears the rail, the phone's bars and the FAB, and
 * which the board's fit already keeps free; it wears that row's floating look. */
describe('the page strip stands in the row where a plan says «which place»', () => {
  const css = readFileSync(`${process.cwd()}/src/styles/09-whiteboard.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const wb = readFileSync(`${process.cwd()}/src/components/Whiteboard.tsx`, 'utf8')
  it('is rendered inside .wb-botleft on the Skizze and on a page, never on its own under the top bar', () => {
    expect(wb).toMatch(/<div className="wb-botleft">\{strip\}<\/div>/) // a Tafel page
    expect(wb).toMatch(/\{strip\}\s*\{objectChip\}/) // the Skizze: first in the plan's row
    expect(wb).not.toMatch(/TAFEL_STRIP_H/)
  })
  it('wears the floating family, not a bar of its own', () => {
    const tps = /\.tps \{([^}]*)\}/.exec(css)?.[1] ?? ''
    for (const t of ['--float-h', '--float-bg', '--float-edge', '--r-sm']) expect(tps).toContain(t)
    expect(tps).not.toMatch(/position:\s*absolute|top:/)
  })
  it('a Tafel page pads its foot by the row, so its last ruling scrolls above the strip', () => {
    expect(wb).toMatch(/bottom: isPhone \? 'calc\(var\(--float-bottom[^']*var\(--float-h\)[^']*' : 'calc\(16px \+ var\(--float-h\)/)
  })
  it('on a phone the row of a Tafel page stands on the nav bar — the page has no tool bar under it', () => {
    const m = readFileSync(`${process.cwd()}/src/styles/15-mobile.css`, 'utf8')
    expect(m).toMatch(/:root:has\(\.phone-tools \.wb-tafel-page\) \{ --float-base: calc\(var\(--rail-h\) \+ 8px/)
  })
})
