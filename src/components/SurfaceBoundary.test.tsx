// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SurfaceBoundary, __resetSurfaceCrashesForTests, noteSurfaceCrash } from './SurfaceBoundary'
import { appConfig } from '../config/appConfig'
import { CRASH_WINDOW_MS } from '../lib/crashLoop'

// The claim this file pins: a view that throws takes ONLY itself down. The sibling standing
// beside the boundary — in the app that is the Atemschutz alarm host — keeps rendering, the card
// appears inside the view, and «Ansicht neu aufbauen» remounts the subtree without a reload.

const c = appConfig.copy.surfaceError

/** throws until `armed` is set to false — so a retry can be made to succeed */
const armed = { current: true }
function Boom() {
  if (armed.current) throw new Error('label missing')
  return <div>view is back</div>
}

beforeEach(() => {
  armed.current = true
  __resetSurfaceCrashesForTests()
  // React logs caught render errors; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SurfaceBoundary', () => {
  it('renders children when nothing throws', () => {
    render(<SurfaceBoundary surface="mittel"><div>Mittel</div></SurfaceBoundary>)
    expect(screen.getByText('Mittel')).toBeTruthy()
  })

  it('shows the card inside the view and leaves the sibling untouched', () => {
    render(
      <>
        <div data-testid="alarm-host">tone running</div>
        <SurfaceBoundary surface="journal" onToMap={() => {}}><Boom /></SurfaceBoundary>
      </>,
    )
    expect(screen.getByText(c.title)).toBeTruthy()
    expect(screen.getByText(c.body)).toBeTruthy()
    // the sibling — the alarm host in the real tree — is still there
    expect(screen.getByTestId('alarm-host').textContent).toBe('tone running')
    // and the card is the in-view kind, not the full-screen login cover
    expect(document.querySelector('.sb-wrap .eb-card')).toBeTruthy()
    expect(document.querySelector('.login')).toBeNull()
  })

  it('remounts only its subtree on «Ansicht neu aufbauen»', () => {
    render(<SurfaceBoundary surface="mittel"><Boom /></SurfaceBoundary>)
    const retry = screen.getByRole('button', { name: c.retry })
    expect(retry.className).toMatch(/primary/)
    armed.current = false
    fireEvent.click(retry)
    expect(screen.getByText('view is back')).toBeTruthy()
    expect(screen.queryByText(c.title)).toBeNull()
  })

  it('offers «Zur Karte» only when the crashed surface is not the map', () => {
    const onToMap = vi.fn()
    render(<SurfaceBoundary surface="mittel" onToMap={onToMap}><Boom /></SurfaceBoundary>)
    fireEvent.click(screen.getByRole('button', { name: c.toMap }))
    expect(onToMap).toHaveBeenCalledOnce()
    cleanup()
    render(<SurfaceBoundary surface="map"><Boom /></SurfaceBoundary>)
    expect(screen.queryByRole('button', { name: c.toMap })).toBeNull()
  })

  it('demotes the retry and names the Rückmeldung on a repeat crash of the same surface', () => {
    render(<SurfaceBoundary surface="mittel"><Boom /></SurfaceBoundary>)
    expect(screen.queryByText(c.repeatHint)).toBeNull()
    // the retry crashes straight away again
    fireEvent.click(screen.getByRole('button', { name: c.retry }))
    expect(screen.getByText(c.repeatHint)).toBeTruthy()
    expect(screen.getByRole('button', { name: c.retry }).className).not.toMatch(/primary/)
  })

  it('counts per surface and forgets crashes outside the window', () => {
    const t0 = 1_000_000
    expect(noteSurfaceCrash('mittel', t0)).toBe(false)
    expect(noteSurfaceCrash('journal', t0 + 1)).toBe(false) // a different view is not a repeat
    expect(noteSurfaceCrash('mittel', t0 + 2)).toBe(true)
    expect(noteSurfaceCrash('mittel', t0 + 2 + CRASH_WINDOW_MS + 1)).toBe(false)
  })
})
