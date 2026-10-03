// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MapViewsButton, type ViewsApi } from './MapViewsMenu'
import { appConfig } from '../config/appConfig'
import { PHONE_QUERY } from '../lib/useIsPhone'
import { setLiveBearing } from '../lib/liveBearing'

afterEach(cleanup)

// jsdom implements no matchMedia, and this dock asks whether it is on a phone (useIsPhone).
// Pinned per test, because the phone is the case with the different behaviour.
const pinViewport = (phone: boolean) => {
  window.matchMedia = ((q: string) => ({
    matches: q === PHONE_QUERY ? phone : false,
    media: q, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

const api = (): ViewsApi => ({
  list: [], current: { bearing: 0, center: [7.5, 47.5], zoom: 16 },
  onGo: vi.fn(), onSave: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
  onResetNorth: vi.fn(), onFit: vi.fn(), onLocate: vi.fn(),
})

const openMenu = (onOpenChange: (o: boolean) => void, onToggleCoords: () => void) => {
  const { rerender } = render(<MapViewsButton api={api()} bearing={0} readOnly={false} variant="util"
    btnClassName="tu" open={false} onOpenChange={onOpenChange} glyphClassName="g"
    coordsOn={false} onToggleCoords={onToggleCoords} />)
  rerender(<MapViewsButton api={api()} bearing={0} readOnly={false} variant="util"
    btnClassName="tu" open onOpenChange={onOpenChange} glyphClassName="g"
    coordsOn={false} onToggleCoords={onToggleCoords} />)
}

// «Koordinaten abgreifen» switches on a read-out at the map's bottom-left. On a tablet the dock
// is a narrow column beside the rail and the flip can be read in place; on a phone the dock is
// most of the screen and lands ON the read-out it just asked for.
describe('the views dock · Koordinaten', () => {
  beforeEach(() => pinViewport(false))

  it('stays open on a tablet, so the state flip is visible where it was tapped', () => {
    const onOpenChange = vi.fn(), onToggleCoords = vi.fn()
    openMenu(onOpenChange, onToggleCoords)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.nav.coords }))
    expect(onToggleCoords).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('closes on a phone — the read-out needs the space the dock is standing in', () => {
    pinViewport(true)
    const onOpenChange = vi.fn(), onToggleCoords = vi.fn()
    openMenu(onOpenChange, onToggleCoords)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.nav.coords }))
    expect(onToggleCoords).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

// The needle used to wait for the END of a two-finger rotate (App's view state only moves on
// moveend) while the wind arrow beside it already turned with the finger. Both read the Karte's
// per-frame store now (lib/liveBearing), without a new `bearing` prop per frame.
describe('the compass needle · live bearing', () => {
  beforeEach(() => pinViewport(false))
  afterEach(() => { act(() => setLiveBearing(null)) })

  const needle = () => document.querySelector<HTMLElement>('.g')!
  const renderCompass = (bearing: number) => render(<MapViewsButton api={api()} bearing={bearing} readOnly={false} variant="util"
    btnClassName="tu" open={false} onOpenChange={vi.fn()} glyphClassName="g" />)

  it('shows the settled bearing while no Karte reports a live one', () => {
    renderCompass(40)
    expect(needle().style.transform).toBe('rotate(-40deg)')
  })

  it('turns on every rotate frame, before the gesture ends', () => {
    renderCompass(0)
    act(() => setLiveBearing(12.5))
    expect(needle().style.transform).toBe('rotate(-12.5deg)')
    act(() => setLiveBearing(-170))
    expect(needle().style.transform).toBe('rotate(170deg)')
  })

  it('falls back to the settled bearing once the Karte unmounts', () => {
    renderCompass(25)
    act(() => setLiveBearing(90))
    act(() => setLiveBearing(null))
    expect(needle().style.transform).toBe('rotate(-25deg)')
  })
})
