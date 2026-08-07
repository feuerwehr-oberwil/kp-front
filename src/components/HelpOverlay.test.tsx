// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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

describe('HelpOverlay states THIS station’s thresholds', () => {
  it('names the amber interval and the Nachfrist that follows it', () => {
    // ⚠️ The line used to read «rot Überfällig (kein Kontakt innert ~5 Min.)», which was wrong
    // twice over: red fires at Intervall + Nachfrist, and both are per-station. A help text that
    // teaches the wrong safety threshold is worse than no help text.
    render(<HelpOverlay onClose={vi.fn()} />)
    // the phrase is a **bold** run, so read the whole list item it lives in
    const line = screen.getByText(/Seit letztem Kontakt/).closest('li')?.textContent ?? ''
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
