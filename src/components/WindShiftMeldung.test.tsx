// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { WindShiftMeldung } from './WindShiftMeldung'
import { Meldeleiste } from './Meldeleiste'
import { serverNowIso } from '../lib/serverClock'
import type { TimelineEvent } from '../types'

// The server observed a wind shift and wrote ONE Verlauf row (backend · app/observations). The
// device shows it on the Meldeleiste once — until waved away, which survives a reload.

afterEach(cleanup)
beforeEach(() => localStorage.clear())

const shiftRow = (): TimelineEvent => ({
  id: 'wxd-202609231740',
  t: '',
  at: serverNowIso(),
  icon: 'wind',
  text: 'Wind dreht: W → NO (286° → 66°) · Lüfter prüfen',
} as TimelineEvent)

describe('WindShiftMeldung', () => {
  it('shows the server row as title and the thing to do, and stays gone once waved away', () => {
    const rows = [shiftRow()]
    render(<><WindShiftMeldung incidentId="inc-1" rows={rows} /><Meldeleiste /></>)
    expect(document.querySelector('.ml-title')?.textContent).toBe('Wind dreht: W → NO (286° → 66°)')
    expect(document.querySelector('.ml-sub')?.textContent).toBe('Lüfter prüfen')
    act(() => { fireEvent.click(document.querySelector<HTMLButtonElement>('.ml-x')!) })
    expect(document.querySelector('.ml-row')).toBeNull()
    cleanup()
    // a reload of the same Einsatz: still gone
    render(<><WindShiftMeldung incidentId="inc-1" rows={rows} /><Meldeleiste /></>)
    expect(document.querySelector('.ml-row')).toBeNull()
  })

  it('says nothing without a wind-shift row', () => {
    render(<><WindShiftMeldung incidentId="inc-1" rows={[{ ...shiftRow(), id: 't1', text: 'Lage erkundet' }]} /><Meldeleiste /></>)
    expect(document.querySelector('.ml-row')).toBeNull()
  })
})
