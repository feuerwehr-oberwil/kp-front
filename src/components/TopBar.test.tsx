// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TopBar } from './TopBar'
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
