// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TopBar, windArrowRotation } from './TopBar'
import { appConfig } from '../config/appConfig'

// The bar's own «Teilen» button was removed on 06.09. — the Einsatz-Karte's «Teilen» row
// (panels/IncidentSwitcher) is now the one door to the share sheet on every width.

// The wind arrow's one piece of maths, kept here since WindBadge (its old home) was deleted as
// dead code on 05.09. — it aims the arrow DOWNWIND, and it has to follow the map's rotation.
describe('windArrowRotation', () => {
  it('rotates by the FROM bearing on a north-up map (aims the arrow downwind)', () => {
    expect(windArrowRotation(225)).toBe(225)
    expect(windArrowRotation(0)).toBe(0)
  })

  it('follows the map rotation by subtracting the bearing (like the compass needle)', () => {
    // map rotated 90° clockwise → the same wind reads 90° less on screen
    expect(windArrowRotation(225, 90)).toBe(135)
    expect(windArrowRotation(45, 45)).toBe(0)
    expect(windArrowRotation(10, 40)).toBe(-30)
  })
})

// S5 (21.10.2026): on a phone the closed-Einsatz chip is its lock alone, so a TAP opens a menu
// whose head says the state and what it means – above the exits, or alone in a link session.
describe('ArchivedChip', () => {
  const bar = (extra: Partial<Parameters<typeof TopBar>[0]>) => render(
    <TopBar incident={{ title: 'Brand', address: 'Hauptstrasse 1' } as Parameters<typeof TopBar>[0]['incident']}
      recording={false} recStartedAt={null} journalOpen={false} onToggleJournal={() => {}}
      onUndo={() => {}} onRedo={() => {}} canUndo={false} canRedo={false} archived {...extra} />,
  )
  afterEach(cleanup)
  const C = appConfig.copy.archived

  it('says what the state means above the exits', async () => {
    bar({ onBackFromArchive: () => {}, onReactivate: async () => 'ok' as const })
    fireEvent.click(screen.getByRole('button', { name: C.title }))
    expect(await screen.findByText(C.hint)).toBeTruthy()
    expect(screen.getByText(C.back)).toBeTruthy()
  })

  // RBAC audit 22.10.2026: «… für alles andere wieder öffnen» only beside «Wieder öffnen»
  it('tells the el (corrects the Rapport, reopens nothing) only the Rapport half', async () => {
    bar({ onBackFromArchive: () => {}, canCorrectRapport: true })
    fireEvent.click(screen.getByRole('button', { name: C.title }))
    expect(await screen.findByText(C.hintRapport)).toBeTruthy()
    expect(screen.queryByText(C.reactivate)).toBeNull()
  })

  it('tells a viewer «Nur ansehen», whatever exits it has', async () => {
    bar({ onBackFromArchive: () => {} })
    fireEvent.click(screen.getByRole('button', { name: C.title }))
    expect(await screen.findByText(C.hintViewOnly)).toBeTruthy()
    expect(screen.getByText(C.back)).toBeTruthy()
  })

  it('is the sentence alone in a link session', async () => {
    bar({})
    fireEvent.click(screen.getByRole('button', { name: C.title }))
    expect(await screen.findByText(C.hintViewOnly)).toBeTruthy()
    expect(screen.queryByText(C.back)).toBeNull()
  })
})
