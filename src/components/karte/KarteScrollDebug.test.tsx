// @vitest-environment jsdom
// The readout follows the switch live: the build line's five taps (lib/scrollDebug) bring it up
// over an open Karte without a reload — the installed app has no address bar (review round 8).
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { KarteScrollDebug } from './KarteScrollDebug'
import { setScrollDebug } from '../../lib/scrollDebug'

afterEach(() => { cleanup(); localStorage.clear() })

describe('KarteScrollDebug', () => {
  it('is nothing until switched on, then shows the frame line, and goes again', () => {
    const { container } = render(<KarteScrollDebug />)
    expect(container.querySelector('[data-debug-scroll]')).toBeNull()
    act(() => setScrollDebug(true))
    const pre = container.querySelector('[data-debug-scroll]')
    expect(pre).not.toBeNull()
    // the first line names the app (installed or tab) and its frame
    expect(pre!.textContent).toMatch(/^(app|tab) \d+×\d+ · doc /)
    act(() => setScrollDebug(false))
    expect(container.querySelector('[data-debug-scroll]')).toBeNull()
  })
})
