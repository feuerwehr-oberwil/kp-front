// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { SessionExpiredMeldung } from './SessionExpiredMeldung'
import { Meldeleiste } from './Meldeleiste'
import { appConfig } from '../config/appConfig'

// The row exists so an expired session is named where the operator is looking, and its ONE
// button is the way back. It must not be dismissible: the sync stands still until the sign-in.

afterEach(cleanup)

describe('SessionExpiredMeldung', () => {
  it('publishes a warn row with «Neu anmelden» as its only action, and no ✕', () => {
    const onRelogin = vi.fn()
    render(<><SessionExpiredMeldung onRelogin={onRelogin} /><Meldeleiste /></>)
    const C = appConfig.copy.session
    expect(document.querySelector('.ml-title')?.textContent).toBe(C.expiredTitle)
    expect(document.querySelector('.ml-sub')?.textContent).toBe(C.expiredHint)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.ml-act button')]
    expect(buttons.map((b) => b.textContent)).toEqual([C.relogin])
    expect(document.querySelector('.ml-x')).toBeNull()
    fireEvent.click(buttons[0])
    expect(onRelogin).toHaveBeenCalledOnce()
  })

  it('withdraws the row when its publisher unmounts (the sign-in clears the flag)', () => {
    const { rerender } = render(<><SessionExpiredMeldung onRelogin={() => {}} /><Meldeleiste /></>)
    expect(document.querySelector('.ml-row')).toBeTruthy()
    rerender(<><Meldeleiste /></>)
    expect(document.querySelector('.ml-row')).toBeNull()
  })
})
