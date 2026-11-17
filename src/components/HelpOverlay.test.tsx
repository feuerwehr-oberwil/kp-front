// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The help has to speak this station's numbers, so the doctrine is stubbed to something that is
// deliberately NOT the shipped default — a test that passes on 5/60 would pass on a hard-coded
// string too.
vi.mock('../lib/deploymentConfig', () => ({
  atemschutzDoctrine: () => ({
    contactIntervalMin: 8, contactGraceSec: 90, pressureStep: 20, alarmBar: 80,
    defaultFunkkanal: 11, funkkanalMin: 1, funkkanalMax: 99,
    defaultPressureBar: 300, pressureMax: 320, cylinderLiters: 7, estConsumptionLPerMin: 50,
  }),
  getDeploymentConfig: () => ({}),
}))

import { HelpOverlay } from './HelpOverlay'
import { TUTORIALS } from '../lib/tutorials/catalogue'
import { getTutorialSession, setTutorialSession } from '../lib/tutorials/session'

// unmount after each test: the scroll-spy's frame must not land after the DOM is torn down
afterEach(cleanup)

describe('HelpOverlay states THIS station’s thresholds', () => {
  it('names the amber interval and the Nachfrist that follows it', () => {
    // ⚠️ The line used to read «rot Überfällig (kein Kontakt innert ~5 Min.)», which was wrong
    // twice over: red fires at Intervall + Nachfrist, and both are per-station. A help text that
    // teaches the wrong safety threshold is worse than no help text.
    render(<HelpOverlay onClose={vi.fn()} />)
    // the phrase is a **bold** run, so read the whole list item it lives in
    const line = screen.getByText(/seit letztem Kontakt/).closest('li')?.textContent ?? ''
    expect(line).toContain('8 min')
    expect(line).toContain('90 s')
    expect(line).not.toContain('~5 Min.')
  })

  it('does not present the Ebenen groups as things every station has', () => {
    render(<HelpOverlay onClose={vi.fn()} />)
    // the overlay renders the section twice on a wide viewport (TOC + body)
    expect(screen.getAllByText(/nichts davon ist mitgeliefert/).length).toBeGreaterThan(0)
  })
})

describe('HelpOverlay «Ausprobieren»', () => {
  const tries = (sectionId: string) =>
    [...document.querySelectorAll(`#help-${sectionId} .help-try button`)].map((b) => b.textContent)

  it('puts one button per mapped tutorial under the section title, none where nothing maps', () => {
    render(<HelpOverlay tutorials={TUTORIALS} onClose={vi.fn()} />)
    expect(tries('atemschutz')).toEqual(['AusprobierenTrupps\u00A0· 6\u00A0Min.', 'AusprobierenAtemschutznotfall\u00A0· 4\u00A0Min.'])
    expect(tries('ueberblick')).toEqual([])
  })

  it('offers none to a session that may start none', () => {
    render(<HelpOverlay onClose={vi.fn()} />)
    expect(document.querySelectorAll('.help-try')).toHaveLength(0)
  })

  it('closes the help and starts the tutorial', () => {
    setTutorialSession(null)
    const onClose = vi.fn()
    render(<HelpOverlay tutorials={TUTORIALS} onClose={onClose} />)
    fireEvent.click(document.querySelector<HTMLElement>('#help-mittel .help-try button')!)
    expect(onClose).toHaveBeenCalled()
    expect(getTutorialSession()).toMatchObject({ id: 'material', step: 0 })
  })
})

// ⚠️ A rare user opens the help with one question and types the word that is on the button
// (rare-user sweep 17.11.2026, ENTRY.5 / HIDDEN.3): «eröffnen» and «Alle Einsätze» used to find
// nothing, because the help said «Neuer Einsatz» and «Einsätze» – words on no screen.
describe('the help search finds what a rare user types', () => {
  // jsdom has no Element.scrollTo; a search scrolls the result list back to its top
  beforeAll(() => { Element.prototype.scrollTo = vi.fn() })
  const hits = (q: string) => {
    render(<HelpOverlay onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Hilfe durchsuchen …'), { target: { value: q } })
    return screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
  }
  it.each([
    ['eröffnen', 'Einsätze verwalten'],
    ['Alle Einsätze', 'Einsätze verwalten'],
    ['Übung', 'Einsätze verwalten'],
    ['PIN', 'Anmelden & Rollen'],
    ['Betrachter', 'Anmelden & Rollen'],
    ['Testalarm', 'Alarme auf diesem Gerät'],
    ['Notfall', 'Trupps & Atemschutz\u00ADüberwachung'],
    ['Messpunkt', 'Zeichnen & Symbole'],
    ['Präsentieren', 'Teilen & Präsentieren'],
    ['Unterschriften', 'Rapport & Abschluss'],
  ])('«%s» → %s', (q, section) => {
    expect(hits(q)).toContain(section)
  })
})
