// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TopBar, windArrowRotation } from './TopBar'
import { appConfig } from '../config/appConfig'
import type { Incident } from '../types'

// «Teilen» in the Einsatzkopf is THE place this app hands an Einsatz to somebody, and what it
// hands out lets a stranger read — or, for the Truppüberwacher, operate — this Einsatz. Since
// 03.09. the button carries no choice of its own: it opens the share sheet, whose tabs are the
// chooser. So what is worth pinning here is the GATE, not a list of rows. Everything upstream
// (viewer, read-only surface, link session) reaches this component as an absent callback, which
// is why «no callback → no button» is the whole matrix from here.

const C = appConfig.copy.topBar

const incident: Incident = {
  type: 'Brand', title: 'Brand Hauptstrasse 4', address: 'Hauptstrasse 4', center: [7.5, 47.5],
  startedAt: new Date().toISOString(), durationSec: 0, offline: false, cachedTiles: 0,
  recording: false, recDurationSec: 0,
}

function bar(props: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return render(
    <TopBar
      incident={incident} recording={false} recStartedAt={null}
      journalOpen={false} onToggleJournal={() => {}}
      onUndo={() => {}} onRedo={() => {}} canUndo={false} canRedo={false}
      {...props}
    />,
  )
}

afterEach(cleanup)

describe('«Teilen» im Einsatzkopf', () => {
  it('is absent for anybody who may not hand this Einsatz out', () => {
    bar()
    expect(screen.queryByRole('button', { name: C.share })).toBeNull()
  })

  // One press, straight to the sheet — no menu step in between. Asking «welcher Link» in a menu
  // and then again in the sheet the menu opens was the same question twice.
  it('opens the share sheet directly, with no choice to make first', () => {
    const onShare = vi.fn()
    bar({ onShare })
    fireEvent.click(screen.getByRole('button', { name: C.share }))
    expect(onShare).toHaveBeenCalledTimes(1)
  })

  // The read-only link outlives the Einsatz and is exactly the one somebody comes back for days
  // later, so the button stays after the Abschluss. Which doors the sheet then offers is the
  // sheet's business (lib/viewLink · shareDoors).
  it('stays after the Abschluss', () => {
    bar({ onShare: () => {}, archived: true })
    expect(screen.getByRole('button', { name: C.share })).toBeTruthy()
  })
})

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
