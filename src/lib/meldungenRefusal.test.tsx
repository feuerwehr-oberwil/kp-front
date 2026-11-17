// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { act, render, cleanup, fireEvent, screen } from '@testing-library/react'
import { RefusalMeldung, refuse } from './meldungenRefusal'
import { Meldeleiste } from '../components/Meldeleiste'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

// FEEDBACK.1 (17.11.2026): on the Atemschutz-Link (no toasts) a refused act is never a silent tap
describe('RefusalMeldung', () => {
  it('shows the last refusal as a row until its ✕, and only refusals made while it stands', () => {
    refuse('vorher')
    render(<><RefusalMeldung /><Meldeleiste /></>)
    expect(document.querySelector('.ml .ml-row')).toBeNull()
    act(() => refuse('Erst «Notfall beendet» halten'))
    expect(document.querySelector('.ml .ml-row')?.textContent).toContain('Erst «Notfall beendet» halten')
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.closeDialog }))
    expect(document.querySelector('.ml .ml-row')).toBeNull()
    // the same refusal again is said again
    act(() => refuse('Erst «Notfall beendet» halten'))
    expect(document.querySelector('.ml .ml-row')).not.toBeNull()
  })
})
