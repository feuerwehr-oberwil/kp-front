// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { SafetyMissingMeldung } from './SafetyMissingMeldung'
import { Meldeleiste } from './Meldeleiste'
import { appConfig } from '../config/appConfig'
import type { Trupp } from '../types'

afterEach(cleanup)

const N = '2026-11-17T02:00:00Z'
const inside: Trupp = { id: 'a', no: 1, name: 'Weber Nina', status: 'aktiv', entryPressureBar: 300, entryTime: N, lastContactTime: N, auftrag: 'loeschen' }
const ready: Trupp = { ...inside, id: 's', no: 2, auftrag: 'sichern', status: 'angemeldet', entryTime: '', lastContactTime: '' }
const nf = appConfig.copy.atemschutz.notfall

// FEEDBACK.1 (17.11.2026, lead): a standing row, not a toast that vanished – and never shown on the Link
describe('SafetyMissingMeldung', () => {
  it('stands while a PA crew is inside uncovered, names it, and cannot be waved away', () => {
    const go = vi.fn()
    render(<><SafetyMissingMeldung trupps={[inside]} onBoard={false} onGoToBoard={go} /><Meldeleiste /></>)
    const row = document.querySelector('.ml .ml-row')!
    expect(row.textContent).toContain(nf.noSafetyHint)
    expect(row.textContent).toContain('Trupp 1')
    expect(row.querySelector('.ml-x')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: nf.noSafetyGo }))
    expect(go).toHaveBeenCalledOnce()
  })

  it('clears itself the moment a Sicherungstrupp is ready, and offers no way to the board it is on', () => {
    const { rerender } = render(<><SafetyMissingMeldung trupps={[inside]} onBoard onGoToBoard={() => {}} /><Meldeleiste /></>)
    expect(screen.queryByRole('button', { name: nf.noSafetyGo })).toBeNull()
    expect(document.querySelector('.ml .ml-row')).not.toBeNull()
    rerender(<><SafetyMissingMeldung trupps={[inside, ready]} onBoard onGoToBoard={() => {}} /><Meldeleiste /></>)
    expect(document.querySelector('.ml .ml-row')).toBeNull()
  })
})
