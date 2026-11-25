// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, renderHook, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { SafetyMissingMeldung } from './SafetyMissingMeldung'
import { Meldeleiste } from './Meldeleiste'
import { appConfig } from '../config/appConfig'
import type { Trupp } from '../types'
import { useSafetyPickAnswer } from '../lib/safetyPick'

afterEach(cleanup)

const N = '2026-11-17T02:00:00Z'
const inside: Trupp = { id: 'a', no: 1, name: 'Weber Nina', status: 'aktiv', entryPressureBar: 300, entryTime: N, lastContactTime: N, auftrag: 'loeschen' }
const ready: Trupp = { ...inside, id: 's', no: 2, auftrag: 'sichern', status: 'angemeldet', entryTime: '', lastContactTime: '' }
const nf = appConfig.copy.atemschutz.notfall

// FEEDBACK.1 (17.11.2026, lead): a standing row, not a toast that vanished
describe('SafetyMissingMeldung', () => {
  it('stands while a PA crew is inside uncovered, counts it, and cannot be waved away', () => {
    const go = vi.fn()
    render(<><SafetyMissingMeldung trupps={[inside]} onGoToBoard={go} /><Meldeleiste /></>)
    const row = document.querySelector('.ml .ml-row')!
    expect(row.textContent).toContain(nf.noSafetyHint)
    // the state as a count, no numbers nobody shows (owner pick UX journeys M·16, 25.11.2026)
    expect(row.textContent).toContain(nf.noSafetySubOne)
    expect(row.textContent).not.toContain('Trupp 1')
    expect(row.querySelector('.ml-x')).toBeNull()
    // a session that cannot write the Trupps keeps the way there
    fireEvent.click(screen.getByRole('button', { name: nf.noSafetyGo }))
    expect(go).toHaveBeenCalledOnce()
  })

  // M·16: «Bestimmen» opens the board's own choice; a pick brings the board forward and waits there
  it('«Bestimmen» offers the crews by state and hands the pick to the board', async () => {
    const go = vi.fn()
    const board = vi.fn()
    renderHook(() => useSafetyPickAnswer(board))
    const waiting: Trupp = { ...inside, id: 'w', no: 3, name: 'Graf Eva', members: ['Frei Nina'], status: 'angemeldet', entryTime: '', lastContactTime: '' }
    render(<><SafetyMissingMeldung trupps={[inside, { ...inside, id: 'b', name: 'Roth Simon' }, waiting]} onGoToBoard={go} canPick /><Meldeleiste /></>)
    expect(document.querySelector('.ml .ml-row')!.textContent).toContain('2 Trupps drin')
    expect(screen.queryByRole('button', { name: nf.noSafetyGo })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.atemschutz.safetyPick }))
    const item = await waitFor(() => screen.getByRole('menuitem', { name: 'Graf Eva / Frei Nina' }))
    expect(screen.getByRole('menuitem', { name: appConfig.copy.atemschutz.safetyPickNew })).toBeTruthy()
    fireEvent.click(item)
    expect(go).toHaveBeenCalledOnce()
    expect(board).toHaveBeenCalledWith({ kind: 'crew', id: 'w' })
  })

  it('clears itself the moment a Sicherungstrupp is ready, and offers no way to the board it is on', () => {
    const { rerender } = render(<><SafetyMissingMeldung trupps={[inside]} /><Meldeleiste /></>)
    expect(screen.queryByRole('button', { name: nf.noSafetyGo })).toBeNull()
    expect(document.querySelector('.ml .ml-row')).not.toBeNull()
    rerender(<><SafetyMissingMeldung trupps={[inside, ready]} /><Meldeleiste /></>)
    expect(document.querySelector('.ml .ml-row')).toBeNull()
  })
})
