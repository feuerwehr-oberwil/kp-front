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

// S5 (20.10.2026): on a phone the closed-Einsatz chip is its lock alone, and the hold-tooltip
// skipped it because the hidden word is still its text. It opts in, on both variants.
describe('ArchivedChip', () => {
  const bar = (extra: Partial<Parameters<typeof TopBar>[0]>) => render(
    <TopBar incident={{ title: 'Brand', address: 'Hauptstrasse 1' } as Parameters<typeof TopBar>[0]['incident']}
      recording={false} recStartedAt={null} journalOpen={false} onToggleJournal={() => {}}
      onUndo={() => {}} onRedo={() => {}} canUndo={false} canRedo={false} archived {...extra} />,
  )
  afterEach(cleanup)

  it('explains itself on a hold, with exits (menu) and without (a link session)', () => {
    const C = appConfig.copy.archived
    bar({ onBackFromArchive: () => {} })
    const withExits = screen.getByRole('button', { name: `${C.title} – ${C.hint}` })
    expect(withExits.hasAttribute('data-holdexplain')).toBe(true)
    cleanup()
    bar({})
    const linkChip = screen.getByRole('button', { name: `${C.title} – ${C.hintViewOnly}` })
    expect(linkChip.hasAttribute('data-holdexplain')).toBe(true)
  })
})

// S6 (20.10.2026): «GPS eingefroren» explained itself only through `title=` on a span — which no
// tablet shows. It is a button now, and a tap opens the sentence in the house popover.
describe('GPS-frozen chip', () => {
  afterEach(cleanup)
  it('opens its explanation on a tap', async () => {
    render(
      <TopBar incident={{ title: 'Brand', address: 'Hauptstrasse 1' } as Parameters<typeof TopBar>[0]['incident']}
        recording={false} recStartedAt={null} journalOpen={false} onToggleJournal={() => {}}
        onUndo={() => {}} onRedo={() => {}} canUndo={false} canRedo={false} gpsStale gpsAgeMs={7 * 60_000} />,
    )
    const chip = screen.getByRole('button', { name: /GPS eingefroren/ })
    expect(screen.queryByText(appConfig.copy.topBar.gpsFrozenHint)).toBeNull()
    fireEvent.click(chip)
    expect(await screen.findByText(appConfig.copy.topBar.gpsFrozenHint)).toBeTruthy()
  })
})
