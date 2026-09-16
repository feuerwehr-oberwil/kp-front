// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { appConfig } from '../config/appConfig'
import { Meldeleiste } from './Meldeleiste'

// A waiting build activates only when EVERY client of the origin is gone — the installed app AND
// any forgotten browser tab on the same site. On Android that made «App schliessen & neu öffnen»
// a piece of advice that can be followed to the letter and still change nothing (field report
// 16.09.2026), so the message carries the apply itself. iOS does not get it: there the in-place
// activation wedges, which is why it was removed for everybody in the first place (2026-07-09).

const applyUpdateNow = vi.fn()
let announce: ((available: boolean) => void) | null = null
vi.mock('../lib/swUpdate', () => ({
  applyUpdateNow: () => applyUpdateNow(),
  onUpdateAvailable: (cb: (a: boolean) => void) => { announce = cb; return () => { announce = null } },
}))

const platform = { value: 'android' }
vi.mock('../lib/installPrompt', () => ({ getInstallPlatform: () => platform.value }))

import { UpdateBanner } from './UpdateBanner'

const C = appConfig.copy.update

const mount = (p: string) => {
  platform.value = p
  render(<><UpdateBanner /><Meldeleiste /></>)
  act(() => announce?.(true))
}

afterEach(() => { cleanup(); applyUpdateNow.mockClear(); announce = null })

describe('UpdateBanner', () => {
  it('offers the apply on Android, and applying it says so instead of pretending nothing happened', () => {
    mount('android')
    expect(screen.getByText(C.hintApply)).toBeTruthy()

    const apply = screen.getByRole('button', { name: C.apply })
    fireEvent.click(apply)
    expect(applyUpdateNow).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: C.applying })).toBeTruthy()
    // ⚠️ and the ✕ is gone while the reload is on its way: a dismiss that raced it left the app
    // looking exactly like an update that had not happened
    expect(screen.queryByRole('button', { name: C.dismiss })).toBeNull()
  })

  it('keeps iOS on the restart wording, with nothing to tap', () => {
    mount('ios')
    expect(screen.getByText(C.hint)).toBeTruthy()
    expect(screen.queryByRole('button', { name: C.apply })).toBeNull()
    expect(screen.getByRole('button', { name: C.dismiss })).toBeTruthy()
  })

  it('says nothing at all while no build is waiting', () => {
    platform.value = 'android'
    render(<><UpdateBanner /><Meldeleiste /></>)
    expect(screen.queryByText(C.available)).toBeNull()
  })
})
